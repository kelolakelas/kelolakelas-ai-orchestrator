import { validatePlanningIssue } from '../intake/planning-contract.js';
import { completeAttempt, startAttempt } from '../execution/stages/stage-support.js';
import type { StageContext, StageHandler, StageOutcome } from '../orchestrator/stage-handler.js';
import type { PersistedTask, PersistedWorkUnit } from '../repositories/task.repository.js';
import type { TaskState } from '../types/domain.js';
import type { RegisteredRepository } from '../workspaces/repository-registry.js';
import {
  classifyDeliveryError, manualDeliveryIntervention, notifyLinearBestEffort, shortSha, syncLinearComment, untrustedText, type DeliveryDependencies,
} from './delivery-support.js';
import { evaluateRequiredChecks, summarizeReviews, type RequiredChecksEvaluation, type ReviewSummary } from './required-checks.js';

/** Delivery status of one repository work unit at one observation. */
export type UnitDelivery =
  | { status: 'blocked'; reason: string }
  | { status: 'checks-pending'; reason: string }
  | { status: 'checks-passed'; reason: string }
  /** Merged on GitHub, but the merge commit is not yet reachable from the remote base branch. */
  | { status: 'merge-unverified'; reason: string }
  | { status: 'merged'; reason: string; mergeCommit: string };

const unitStates: Record<UnitDelivery['status'], TaskState> = {
  blocked: 'BLOCKED',
  'checks-pending': 'WAITING_CI',
  'checks-passed': 'READY_FOR_HUMAN_REVIEW',
  'merge-unverified': 'READY_FOR_HUMAN_REVIEW',
  merged: 'COMPLETED',
};

interface ObservedUnit {
  unit: PersistedWorkUnit;
  repository: RegisteredRepository;
  delivery: UnitDelivery;
  pullRequestUrl: string;
  checks: RequiredChecksEvaluation | null;
  reviews: ReviewSummary | null;
  /** Normalized GitHub state persisted on the work unit. */
  observation: Record<string, unknown>;
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/**
 * `WAITING_CI` and `READY_FOR_HUMAN_REVIEW`: observes every repository's pull request on GitHub. Required checks come
 * from the base branch policy on GitHub, never from the issue, and only explicit successes count. The orchestrator
 * never merges: a task completes only when every pull request is merged and its merge commit is reachable from the
 * remote base branch. Until then the task waits without holding a lease and reports partial delivery per repository.
 * A closed, retargeted, rewritten, or conflicting pull request, a failed required check, a missing policy, or a check
 * that never reports blocks the task for manual intervention.
 */
export class DeliveryObservationStage implements StageHandler {
  constructor(private readonly deps: DeliveryDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    try {
      const contract = validatePlanningIssue(task.contractSnapshot);
      const units = await deps.tasks.getWorkUnits(task.id);
      if (units.map((unit) => unit.repository).join('\0') !== [...contract.repositories].sort().join('\0')) {
        return manualDeliveryIntervention('Work units do not match contract repositories');
      }
      const observed: ObservedUnit[] = [];
      for (const unit of units) {
        if (context.signal.aborted) return { kind: 'interrupted' };
        const result = await this.observe(unit);
        observed.push(result);
        await deps.tasks.recordWorkUnitDelivery(task.id, deps.workerId, unit.repository, {
          state: unitStates[result.delivery.status],
          outcome: result.delivery.reason,
          mergeCommit: result.delivery.status === 'merged' ? result.delivery.mergeCommit : null,
          observation: result.observation,
        });
      }
      const report = observed.map((entry) => `${entry.unit.repository}: ${entry.delivery.reason}`).join('; ');
      context.log('delivery_observed', { units: observed.map((entry) => ({ repository: entry.unit.repository, status: entry.delivery.status })) });
      return await this.decide(context, task, observed, report);
    } catch (error) {
      return classifyDeliveryError(deps, error).outcome;
    }
  }

  private async decide(context: StageContext, task: PersistedTask, observed: ObservedUnit[], report: string): Promise<StageOutcome> {
    const { deps } = this;
    const statuses = observed.map((entry) => entry.delivery.status);
    const poll = (reason: string): StageOutcome => ({ kind: 'wait', until: new Date(deps.clock().getTime() + deps.delivery.pollIntervalSeconds * 1_000), reason, lastError: null });
    const links = (entries: readonly ObservedUnit[], detail: (entry: ObservedUnit) => string) => entries
      .map((entry) => `- \`${entry.unit.repository}\`: [${entry.repository.github}#${entry.unit.pullRequestNumber}](${entry.pullRequestUrl}): ${detail(entry)}`).join('\n');

    if (statuses.includes('blocked')) {
      const blocked = observed.filter((entry) => entry.delivery.status === 'blocked');
      const message = blocked.map((entry) => `${entry.unit.repository}: ${entry.delivery.reason}`).join('; ');
      await this.recordOutcome(task, observed, 'delivery-rejected');
      await notifyLinearBestEffort(deps, task, {
        event: 'delivery-blocked',
        identity: message,
        body: `**Delivery blocked**; manual intervention required.\n\n${links(observed, (entry) => untrustedText(entry.delivery.reason, deps.knownSecrets, 500))}`,
      }, context.log);
      return manualDeliveryIntervention(message, 'Pull request delivery blocked');
    }

    const heads = Object.fromEntries(observed.map((entry) => [entry.unit.repository, (entry.observation.pullRequest as { headSha: string }).headSha]));
    if (statuses.every((status) => status === 'merged')) {
      if (task.state === 'WAITING_CI') return this.advance(task, observed, 'READY_FOR_HUMAN_REVIEW', 'Every pull request is merged');
      await syncLinearComment(deps, task, {
        event: 'delivery-completed',
        identity: observed.map((entry) => (entry.delivery as { mergeCommit: string }).mergeCommit),
        body: [
          '**Every pull request is merged** and verified reachable from its base branch.',
          '',
          links(observed, (entry) => `merge commit \`${shortSha((entry.delivery as { mergeCommit: string }).mergeCommit)}\``),
          '',
          'The orchestrator task is complete. Check the acceptance criteria before moving this issue to Done.',
        ].join('\n'),
      });
      return this.advance(task, observed, 'COMPLETED', 'Every pull request is merged and reachable from its base branch');
    }

    if (statuses.every((status) => status === 'checks-passed' || status === 'merged' || status === 'merge-unverified')) {
      if (task.state === 'READY_FOR_HUMAN_REVIEW') return poll(`Awaiting human review and merge: ${report}`);
      await syncLinearComment(deps, task, {
        event: 'ready-for-human-review',
        identity: heads,
        body: [
          '**Required checks passed**; the pull requests are ready for human review and merge.',
          '',
          links(observed, (entry) => entry.delivery.status === 'checks-passed'
            ? `${entry.checks?.checks.map((check) => `\`${check.context}\``).join(', ') ?? ''} passed; ${entry.reviews?.approvedBy.length ?? 0} approval(s)`
            : 'merged'),
        ].join('\n'),
      });
      return this.advance(task, observed, 'READY_FOR_HUMAN_REVIEW', `Required checks passed: ${report}`);
    }

    // Some repository has required checks pending, for example after its pull request head moved.
    if (task.state === 'READY_FOR_HUMAN_REVIEW') return this.advance(task, observed, 'WAITING_CI', `Required checks are running again: ${report}`);
    return poll(`Waiting for required checks: ${report}`);
  }

  private async advance(task: PersistedTask, observed: readonly ObservedUnit[], to: TaskState, reason: string): Promise<StageOutcome> {
    await this.recordOutcome(task, observed, null);
    return { kind: 'advance', to, reason: reason.slice(0, 1_000), lastError: null };
  }

  /** One attempt per state change, not per poll, with the observations that justified it. */
  private async recordOutcome(task: PersistedTask, observed: readonly ObservedUnit[], category: 'delivery-rejected' | null): Promise<void> {
    const scope = await startAttempt(this.deps, task, { pullRequests: observed.map((entry) => ({ repository: entry.unit.repository, number: entry.unit.pullRequestNumber })) });
    await completeAttempt(scope, {
      category,
      evidence: { units: observed.map((entry) => ({ repository: entry.unit.repository, status: entry.delivery.status, reason: entry.delivery.reason, ...entry.observation })) },
    });
  }

  private async observe(unit: PersistedWorkUnit): Promise<ObservedUnit> {
    const { deps } = this;
    const repository = deps.registry.get(unit.repository);
    const blocked = (reason: string, observation: Record<string, unknown> = {}) => this.result(unit, repository, { status: 'blocked', reason }, observation, unit.pullRequestUrl ?? '', null, null);
    if (unit.pushedCommit === null || unit.pullRequestNumber === null || unit.branch === null) {
      return blocked('No delivered pull request is recorded for this repository');
    }

    const pullRequest = await deps.github.getPullRequest(repository.github, unit.pullRequestNumber);
    const now = deps.clock();
    const previous = (unit.deliveryObservation ?? {}) as { pullRequest?: { headSha?: string }; headFirstObservedAt?: string };
    const headFirstObservedAt = previous.pullRequest?.headSha === pullRequest.headSha && previous.headFirstObservedAt !== undefined
      ? previous.headFirstObservedAt
      : now.toISOString();
    const observation: Record<string, unknown> = {
      observedAt: now.toISOString(),
      headFirstObservedAt,
      pullRequest: {
        number: pullRequest.number, state: pullRequest.state, merged: pullRequest.merged, draft: pullRequest.draft, headSha: pullRequest.headSha,
        baseRef: pullRequest.baseRef, mergeableState: pullRequest.mergeableState, mergeCommitSha: pullRequest.mergeCommitSha,
      },
    };
    const url = pullRequest.url;

    if (pullRequest.headRepository !== repository.github || pullRequest.headRef !== unit.branch) {
      return blocked(`Pull request #${pullRequest.number} no longer comes from ${repository.github}:${unit.branch}`, observation);
    }
    if (pullRequest.baseRef !== repository.baseBranch) {
      return blocked(`Pull request #${pullRequest.number} was retargeted to ${pullRequest.baseRef}`, observation);
    }
    if (pullRequest.headSha !== unit.pushedCommit) {
      const relation = await deps.github.compareCommits(repository.github, unit.pushedCommit, pullRequest.headSha);
      if (relation !== 'ahead' && relation !== 'identical') {
        return blocked(`Pull request #${pullRequest.number} no longer contains the reviewed commit ${shortSha(unit.pushedCommit)}; it was force-pushed`, observation);
      }
    }
    if (pullRequest.state === 'closed' && !pullRequest.merged) {
      return blocked(`Pull request #${pullRequest.number} was closed without merging`, observation);
    }

    const timedOut = minutesBetween(new Date(headFirstObservedAt), now) > deps.delivery.requiredChecksTimeoutMinutes;
    if (pullRequest.merged) {
      if (pullRequest.mergeCommitSha === null) {
        return this.result(unit, repository, { status: 'merge-unverified', reason: `Pull request #${pullRequest.number} merged; merge commit not reported yet` }, observation, url, null, null);
      }
      const relation = await deps.github.compareCommits(repository.github, pullRequest.mergeCommitSha, repository.baseBranch);
      observation.mergeCommitReachable = relation === 'ahead' || relation === 'identical';
      if (observation.mergeCommitReachable) {
        return this.result(unit, repository, { status: 'merged', reason: `Merged as ${shortSha(pullRequest.mergeCommitSha)}`, mergeCommit: pullRequest.mergeCommitSha }, observation, url, null, null);
      }
      if (timedOut) return blocked(`Merge commit ${shortSha(pullRequest.mergeCommitSha)} is not reachable from ${repository.baseBranch} (${relation})`, observation);
      return this.result(unit, repository, { status: 'merge-unverified', reason: `Merge commit ${shortSha(pullRequest.mergeCommitSha)} not yet reachable from ${repository.baseBranch}` }, observation, url, null, null);
    }

    if (pullRequest.mergeableState === 'dirty') {
      return blocked(`Pull request #${pullRequest.number} conflicts with ${repository.baseBranch}`, observation);
    }
    const policy = await deps.github.getBranchPolicy(repository.github, repository.baseBranch);
    const checks = evaluateRequiredChecks(policy, await deps.github.listChecks(repository.github, pullRequest.headSha));
    const reviews = summarizeReviews(await deps.github.listReviews(repository.github, pullRequest.number), pullRequest.headSha, policy.requiredApprovingReviews);
    observation.requiredChecks = checks;
    observation.reviews = reviews;

    if (checks.outcome === 'no-policy') {
      return this.result(unit, repository, { status: 'blocked', reason: `${repository.baseBranch} of ${repository.github} requires no status checks; the merge gate is misconfigured` }, observation, url, checks, reviews);
    }
    if (checks.outcome === 'failed') {
      const failed = checks.checks.filter((check) => check.state === 'failed').map((check) => `${check.context} (${check.conclusions.join(', ')})`).join(', ');
      return this.result(unit, repository, { status: 'blocked', reason: `Required check failed on ${shortSha(pullRequest.headSha)}: ${failed}` }, observation, url, checks, reviews);
    }
    if (checks.outcome === 'pending') {
      const waiting = checks.checks.filter((check) => check.state !== 'success').map((check) => `${check.context} ${check.state}`).join(', ');
      if (timedOut) {
        return this.result(unit, repository, { status: 'blocked', reason: `Required checks did not succeed within ${deps.delivery.requiredChecksTimeoutMinutes} minutes: ${waiting}` }, observation, url, checks, reviews);
      }
      return this.result(unit, repository, { status: 'checks-pending', reason: `Required checks pending: ${waiting}` }, observation, url, checks, reviews);
    }
    const approvals = reviews.requiredApprovingReviews === null ? `${reviews.approvedBy.length} approval(s)` : `${reviews.approvedBy.length}/${reviews.requiredApprovingReviews} approval(s)`;
    return this.result(unit, repository, { status: 'checks-passed', reason: `Required checks passed on ${shortSha(pullRequest.headSha)}; ${approvals}; awaiting merge` }, observation, url, checks, reviews);
  }

  private result(
    unit: PersistedWorkUnit,
    repository: RegisteredRepository,
    delivery: UnitDelivery,
    observation: Record<string, unknown>,
    pullRequestUrl: string,
    checks: RequiredChecksEvaluation | null,
    reviews: ReviewSummary | null,
  ): ObservedUnit {
    return { unit, repository, delivery, pullRequestUrl, checks, reviews, observation };
  }
}
