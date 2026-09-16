import { createHash } from 'node:crypto';
import type { DeliveryConfig } from '../config/schema.js';
import type { ExecutionDependencies, FailureCategory } from '../execution/stages/stage-support.js';
import { redactSecrets } from '../execution/secrets.js';
import type { StageOutcome } from '../orchestrator/stage-handler.js';
import { GitHubRequestError, type GitHubProvider } from '../providers/github.js';
import type { LinearIssueWriter } from '../providers/linear.js';
import { stableJson, type PersistedTask } from '../repositories/task.repository.js';
import { WorkspaceBlockedError } from '../workspaces/repository-registry.js';
import { RemoteUnavailableError } from '../workspaces/workspace-manager.js';

export interface DeliveryDependencies extends ExecutionDependencies {
  delivery: DeliveryConfig;
  github: GitHubProvider;
  linear: LinearIssueWriter;
}

/** A Linear write failed. Linear availability never decides delivery correctness, so it is retried later. */
export class LinearSyncError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Linear ${operation} failed: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    this.name = 'LinearSyncError';
  }
}

export type DeliveryFailureCategory = Extract<FailureCategory, 'provider-unavailable' | 'rate-limit' | 'provider-rejected' | 'delivery-rejected' | 'workspace-integrity' | 'linear-unavailable'>;

export function manualDeliveryIntervention(message: string, reason = 'Delivery requires manual intervention'): StageOutcome {
  return { kind: 'advance', to: 'BLOCKED', reason, lastError: message, requiresManualIntervention: true };
}

/**
 * Maps delivery errors to stage outcomes. Transient provider and remote failures wait in the current state and are
 * reconciled on the next run, because every delivery side effect is observable. Rejections, authentication failures, and
 * ownership problems need an operator. Unknown errors are rethrown so the scheduler blocks the task.
 */
export function classifyDeliveryError(deps: DeliveryDependencies, error: unknown): { outcome: StageOutcome; category: DeliveryFailureCategory } {
  const retryAt = (hint: Date | null = null) => {
    const fallback = new Date(deps.clock().getTime() + deps.delivery.retryIntervalSeconds * 1_000);
    return hint !== null && hint > deps.clock() ? hint : fallback;
  };
  const message = redactSecrets(error instanceof Error ? error.message : 'Unknown error', deps.knownSecrets);
  if (error instanceof GitHubRequestError) {
    if (error.kind === 'transient') {
      return { category: 'provider-unavailable', outcome: { kind: 'wait', until: retryAt(), reason: 'GitHub unavailable', lastError: message } };
    }
    if (error.kind === 'rate-limit') {
      return { category: 'rate-limit', outcome: { kind: 'wait', until: retryAt(error.retryAfter), reason: 'GitHub rate limit', lastError: message } };
    }
    return { category: 'provider-rejected', outcome: manualDeliveryIntervention(message, 'GitHub rejected a delivery request') };
  }
  if (error instanceof RemoteUnavailableError) {
    return { category: 'provider-unavailable', outcome: { kind: 'wait', until: retryAt(), reason: 'Git remote unavailable', lastError: message } };
  }
  if (error instanceof LinearSyncError) {
    return { category: 'linear-unavailable', outcome: { kind: 'wait', until: retryAt(), reason: 'Linear unavailable', lastError: message } };
  }
  if (error instanceof WorkspaceBlockedError) {
    return { category: 'workspace-integrity', outcome: manualDeliveryIntervention(message) };
  }
  throw error;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

/**
 * Runs an external side effect under a durable intent record keyed by a stable identity. The record is written before
 * the effect, so a crash between the effect and its completion leaves a `PENDING` record; `effect` must reconcile with
 * the external system before acting, which makes a retry converge instead of duplicating. A `SUCCEEDED` record returns
 * its stored response without repeating the effect.
 */
export async function idempotentOperation<T extends Record<string, unknown>>(
  deps: DeliveryDependencies,
  task: PersistedTask,
  operation: { type: string; key: string; request: Record<string, unknown> },
  effect: (previous: 'PENDING' | 'NEW') => Promise<T>,
): Promise<{ response: T; repeated: boolean }> {
  const { operation: before, created } = await deps.tasks.beginExternalOperation({ taskId: task.id, operationType: operation.type, idempotencyKey: operation.key, request: operation.request });
  if (before.taskId !== task.id) throw new WorkspaceBlockedError(`External operation ${operation.key} belongs to another task`);
  if (before.status === 'SUCCEEDED') return { response: (before.response ?? {}) as T, repeated: true };
  const response = await effect(created ? 'NEW' : 'PENDING');
  await deps.tasks.completeExternalOperation({ operationId: before.id, taskId: task.id, leaseOwner: deps.workerId, response });
  return { response, repeated: false };
}

/**
 * Text from Linear issues and model output shown on GitHub or Linear. Credentials are redacted, control characters are
 * removed, and mentions and issue references are neutralized so untrusted text cannot notify people or close issues.
 */
export function untrustedText(value: string, knownSecrets: readonly string[], limit: number): string {
  const cleaned = redactSecrets(value, knownSecrets)
    .replace(/[^\P{C}\n\t]/gu, '')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Posts a milestone comment at most once. The key is written into the body so a lost response is reconciled by reading comments. */
export async function syncLinearComment(
  deps: DeliveryDependencies,
  task: PersistedTask,
  input: { event: string; identity: unknown; body: string },
): Promise<void> {
  if (!deps.delivery.linearComments) return;
  const issueId = task.linearIssueId;
  const key = `kelolakelas-orchestrator:${task.id}:${input.event}:${digest(input.identity)}`;
  const body = `${input.body}\n\n<sub>Orchestrator event \`${key}\`. The orchestrator never merges and never changes this issue's status.</sub>`;
  await idempotentOperation(deps, task, { type: 'LINEAR_COMMENT', key, request: { event: input.event, issueId } }, async (previous) => {
    try {
      if (previous === 'PENDING') {
        const existing = (await deps.linear.listComments(issueId)).find((comment) => comment.body.includes(key));
        if (existing) return { commentId: existing.id, reconciled: true };
      }
      return { commentId: (await deps.linear.createComment(issueId, body)).id, reconciled: false };
    } catch (error) {
      throw new LinearSyncError('comment', error);
    }
  });
}

/** Links a pull request to the Linear issue. Linear keys attachments by issue and URL, so a repeated call updates in place. */
export async function syncLinearPullRequestLink(
  deps: DeliveryDependencies,
  task: PersistedTask,
  input: { repository: string; github: string; number: number; url: string },
): Promise<void> {
  const key = `kelolakelas-orchestrator:${task.id}:linear-attachment:${input.repository}:${input.number}`;
  await idempotentOperation(deps, task, { type: 'LINEAR_ATTACHMENT', key, request: { url: input.url } }, async () => {
    try {
      const attachment = await deps.linear.attachLink(task.linearIssueId, {
        url: input.url,
        title: `Pull request #${input.number} · ${input.github}`,
        subtitle: `${task.linearIdentifier} · ${input.repository} · KelolaKelas AI orchestrator`,
      });
      return { attachmentId: attachment.id };
    } catch (error) {
      throw new LinearSyncError('attachment', error);
    }
  });
}

/** Best-effort notification that never prevents a task from blocking. */
export async function notifyLinearBestEffort(deps: DeliveryDependencies, task: PersistedTask, input: { event: string; identity: unknown; body: string }, log: (event: string, fields?: Record<string, unknown>) => void): Promise<void> {
  try {
    await syncLinearComment(deps, task, input);
  } catch (error) {
    log('linear_sync_failed', { event: input.event, error: redactSecrets(error instanceof Error ? error.message : 'Unknown error', deps.knownSecrets) });
  }
}
