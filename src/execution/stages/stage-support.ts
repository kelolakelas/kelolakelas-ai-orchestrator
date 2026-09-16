import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentsConfig, OrchestratorConfig } from '../../config/schema.js';
import { validatePlanningIssue, type PlanningIssue } from '../../intake/planning-contract.js';
import type { StageContext, StageOutcome } from '../../orchestrator/stage-handler.js';
import { stableJson, type PersistedTask, type TaskRepository } from '../../repositories/task.repository.js';
import type { ModelSelection } from '../../routing/model-router.js';
import type { TaskState } from '../../types/domain.js';
import type { RepositoryName, RepositoryRegistry } from '../../workspaces/repository-registry.js';
import { WorkspaceBlockedError } from '../../workspaces/repository-registry.js';
import type { TaskWorkspace, WorkspaceManager } from '../../workspaces/workspace-manager.js';
import { analysisResultSchema, type AnalysisResult } from '../agent-results.js';
import type { AgentRunner, AgentRunResult, AgentUsage } from '../agent-runner.js';
import type { DocumentationLoader } from '../documentation.js';
import type { PromptWorkspace } from '../prompts.js';
import type { QualityGateRunner } from '../quality-gates.js';
import type { WorkspaceChanges } from '../workspace-changes.js';

export interface ExecutionDependencies {
  config: OrchestratorConfig;
  agents: AgentsConfig;
  tasks: TaskRepository;
  registry: RepositoryRegistry;
  workspaces: WorkspaceManager;
  changes: WorkspaceChanges;
  runner: AgentRunner;
  quality: QualityGateRunner;
  documentation: DocumentationLoader;
  workerId: string;
  knownSecrets: readonly string[];
  clock: () => Date;
}

/** Durable progress markers. Each stage re-reads them so a resumed, parked, or retried stage never repeats finished work. */
export const checkpointKeys = {
  analysis: 'analysis-accepted',
  setup: 'workspace-setup',
  implementation: 'implementation-committed',
  implementationRejection: 'implementation-rejected',
  qualityPassed: 'quality-passed',
  fixRequest: 'fix-request',
  fixApplied: 'fix-applied',
  reviewApproved: 'review-approved',
} as const;

/** Why a stage attempt did not succeed. Persisted on `task_attempts.failure_category`. */
export type FailureCategory =
  | 'usage-limit'
  | 'rate-limit'
  | 'timeout'
  | 'cancelled'
  | 'runner-failed'
  | 'invalid-output'
  | 'agent-blocked'
  | 'needs-clarification'
  | 'workspace-integrity'
  | 'diff-rejected'
  | 'quality-failed'
  | 'quality-infrastructure'
  | 'review-changes-requested'
  | 'review-rejected';

const headsSchema = z.record(z.string());
export type Heads = Record<string, string>;

export const analysisCheckpointSchema = z.object({ contractDigest: z.string(), attempt: z.number().int(), plan: analysisResultSchema });
export const setupCheckpointSchema = z.object({ heads: headsSchema });
export const implementationCheckpointSchema = z.object({ implementationAttempt: z.number().int(), commits: headsSchema });
export const implementationRejectionSchema = z.object({ implementationAttempt: z.number().int(), category: z.string(), detail: z.string() });
export const qualityPassedSchema = z.object({ heads: headsSchema, attempt: z.number().int() });
export const fixRequestSchema = z.object({
  id: z.string(),
  source: z.enum(['quality', 'review']),
  heads: headsSchema,
  details: z.unknown(),
});
export const fixAppliedSchema = z.object({ requestId: z.string(), commits: headsSchema.nullable(), category: z.string().nullable() });
export const reviewApprovedSchema = z.object({ heads: headsSchema, attempt: z.number().int(), summary: z.string() });

export async function readCheckpoint<T>(context: StageContext, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const payload = await context.getCheckpoint(key);
  if (payload === undefined) return undefined;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WorkspaceBlockedError(`Checkpoint ${key} is malformed; manual recovery required`);
  return parsed.data;
}

export function contractDigest(task: PersistedTask): string {
  return createHash('sha256').update(stableJson(task.contractSnapshot)).digest('hex');
}

export function sameHeads(left: Heads, right: Heads): boolean {
  return stableJson(left) === stableJson(right);
}

export interface LoadedWorkspaces {
  contract: PlanningIssue;
  taskDirectory: string;
  units: Array<TaskWorkspace & { head: string }>;
  heads: Heads;
  prompt: PromptWorkspace[];
}

/**
 * Loads and verifies every declared repository workspace of the task. Only work units that match the validated contract
 * are used, and each worktree is re-verified before an agent or command touches it.
 */
export async function loadTaskWorkspaces(deps: ExecutionDependencies, task: PersistedTask): Promise<LoadedWorkspaces> {
  const contract = validatePlanningIssue(task.contractSnapshot);
  const units = await deps.tasks.getWorkUnits(task.id);
  const declared = [...contract.repositories].sort();
  if (units.map((unit) => unit.repository).join('\0') !== declared.join('\0')) {
    throw new WorkspaceBlockedError('Work units do not match contract repositories');
  }
  const loaded: LoadedWorkspaces['units'] = [];
  for (const unit of units) {
    if (unit.workspacePath === null || unit.branch === null || unit.baseCommit === null) {
      throw new WorkspaceBlockedError(`Workspace for ${unit.repository} has not been prepared`);
    }
    const workspace: TaskWorkspace = {
      taskId: task.id,
      repository: unit.repository as RepositoryName,
      workspacePath: unit.workspacePath,
      branch: unit.branch,
      baseCommit: unit.baseCommit,
    };
    const { head } = await deps.workspaces.verifyTaskWorkspace(workspace);
    loaded.push({ ...workspace, head });
  }
  return {
    contract,
    taskDirectory: deps.registry.taskDirectory(task.id),
    units: loaded,
    heads: Object.fromEntries(loaded.map((unit) => [unit.repository, unit.head])),
    prompt: loaded.map((unit) => ({ repository: unit.repository, directory: unit.repository, branch: unit.branch, baseCommit: unit.baseCommit })),
  };
}

export async function restoreAll(deps: ExecutionDependencies, loaded: LoadedWorkspaces): Promise<boolean> {
  let discarded = false;
  for (const unit of loaded.units) discarded = (await deps.workspaces.restoreWorkspace(unit)).discarded || discarded;
  return discarded;
}

/** Proves a read-only agent left every worktree exactly as it found it. */
export async function workspaceSnapshots(deps: ExecutionDependencies, loaded: LoadedWorkspaces): Promise<string> {
  const snapshots: Record<string, unknown> = {};
  for (const unit of loaded.units) snapshots[unit.repository] = await deps.changes.snapshot(unit.workspacePath);
  return stableJson(snapshots);
}

export function manualIntervention(message: string, reason = 'Manual intervention required'): StageOutcome {
  return { kind: 'advance', to: 'BLOCKED', reason, lastError: message, requiresManualIntervention: true };
}

export function usageRecord(usage: AgentUsage | null): Record<string, unknown> | null {
  return usage === null ? null : { ...usage };
}

/**
 * Maps runner results that stop the stage without consuming an attempt: provider limits pause the task, and an
 * abort (shutdown, schedule, operator, lease loss) interrupts it at a safe point.
 */
export function pauseOrInterruption(deps: ExecutionDependencies, result: AgentRunResult<unknown>): { outcome: StageOutcome; category: FailureCategory } | undefined {
  switch (result.kind) {
    case 'usage-limit':
      return {
        category: 'usage-limit',
        outcome: { kind: 'pause-limit', pauseReason: 'CODEX_USAGE_LIMIT', reason: result.message, ...(result.retryAfter === null ? {} : { resumeAfter: result.retryAfter }) },
      };
    case 'rate-limit':
      return {
        category: 'rate-limit',
        outcome: {
          kind: 'pause-limit',
          pauseReason: 'RATE_LIMIT',
          reason: result.message,
          resumeAfter: result.retryAfter ?? new Date(deps.clock().getTime() + deps.agents.runner.rateLimitRetryMinutes * 60_000),
        },
      };
    case 'cancelled':
      return { category: 'cancelled', outcome: { kind: 'interrupted' } };
    default:
      return undefined;
  }
}

export function failureCategoryOf(kind: 'invalid-output' | 'timeout' | 'failed'): FailureCategory {
  return kind === 'failed' ? 'runner-failed' : kind;
}

export interface AttemptScope {
  deps: ExecutionDependencies;
  task: PersistedTask;
  stage: TaskState;
  attempt: number;
}

export async function startAttempt(deps: ExecutionDependencies, task: PersistedTask, input: Record<string, unknown>): Promise<AttemptScope> {
  const attempt = await deps.tasks.startAttempt({ taskId: task.id, stage: task.state, leaseOwner: deps.workerId, input });
  return { deps, task, stage: task.state, attempt };
}

export async function completeAttempt(
  scope: AttemptScope,
  outcome: { category: FailureCategory | null; result?: Record<string, unknown> | null; evidence?: Record<string, unknown> | null; usage?: AgentUsage | null },
): Promise<void> {
  await scope.deps.tasks.completeAttempt({
    taskId: scope.task.id,
    stage: scope.stage,
    attempt: scope.attempt,
    failureCategory: outcome.category,
    result: outcome.result ?? null,
    evidence: outcome.evidence ?? null,
    usage: usageRecord(outcome.usage ?? null),
  });
}

export function modelInput(model: ModelSelection): Record<string, unknown> {
  return { tier: model.tier, model: model.model, effort: model.effort };
}

export async function requireAnalysis(context: StageContext): Promise<AnalysisResult> {
  const analysis = await readCheckpoint(context, checkpointKeys.analysis, analysisCheckpointSchema);
  if (analysis === undefined) throw new WorkspaceBlockedError('No accepted analysis exists for this task; manual recovery required');
  return analysis.plan;
}

export function plannedPaths(plan: AnalysisResult): Record<string, string[]> {
  return Object.fromEntries(plan.repositories.map((entry) => [entry.repository, entry.changes.map((change) => change.path)]));
}

/** Commit messages carry model text; strip control characters and bound the size. */
export function commitMessage(subject: string, body: string, trailers: Record<string, string>): string {
  const clean = (value: string, limit: number) => value.replace(/[^\P{C}\n\t]/gu, '').trim().slice(0, limit);
  return [
    clean(subject.replace(/\s+/g, ' '), 120),
    clean(body, 2_000),
    Object.entries(trailers).map(([key, value]) => `${key}: ${clean(value, 200)}`).join('\n'),
  ].filter(Boolean).join('\n\n');
}
