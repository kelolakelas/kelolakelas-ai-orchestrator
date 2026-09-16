import type { BranchPolicy, CheckResult, PullRequestReview, RequiredCheck } from '../providers/github.js';

export type RequiredCheckState = 'success' | 'pending' | 'missing' | 'failed';

export interface RequiredCheckObservation {
  context: string;
  appId: number | null;
  source: RequiredCheck['source'];
  state: RequiredCheckState;
  /** Conclusions of every matching check, for evidence. */
  conclusions: Array<string | null>;
}

export interface RequiredChecksEvaluation {
  /**
   * `passed` only when the policy requires at least one check and every required check succeeded. `no-policy` means the
   * base branch requires no check, which is a misconfigured merge gate rather than a success.
   */
  outcome: 'passed' | 'pending' | 'failed' | 'no-policy';
  checks: RequiredCheckObservation[];
}

function stateOf(check: CheckResult): RequiredCheckState {
  if (check.kind === 'status') {
    if (check.status === 'pending') return 'pending';
    return check.conclusion === 'success' ? 'success' : 'failed';
  }
  if (check.status !== 'completed') return 'pending';
  // Only an explicit success counts. Neutral, skipped, cancelled, stale, timed-out, and action-required results do not.
  return check.conclusion === 'success' ? 'success' : 'failed';
}

/**
 * Evaluates the checks reported for a pull request head against the base branch policy read from GitHub. A required
 * check pinned to an app only matches runs from that app. When several reports match one requirement, any failure
 * fails it and any pending report keeps it pending.
 */
export function evaluateRequiredChecks(policy: BranchPolicy, reported: readonly CheckResult[]): RequiredChecksEvaluation {
  const required = new Map<string, RequiredCheck>();
  for (const check of policy.requiredChecks) required.set(`${check.context}\0${check.appId ?? ''}`, check);
  if (required.size === 0) return { outcome: 'no-policy', checks: [] };

  const checks = [...required.values()].map((requirement): RequiredCheckObservation => {
    const matches = reported.filter((check) => check.name === requirement.context && (requirement.appId === null || check.appId === requirement.appId));
    const states = matches.map(stateOf);
    const state: RequiredCheckState = matches.length === 0
      ? 'missing'
      : states.includes('failed') ? 'failed' : states.includes('pending') ? 'pending' : 'success';
    return { context: requirement.context, appId: requirement.appId, source: requirement.source, state, conclusions: matches.map((check) => check.conclusion) };
  });
  const outcome = checks.some((check) => check.state === 'failed')
    ? 'failed'
    : checks.every((check) => check.state === 'success') ? 'passed' : 'pending';
  return { outcome, checks };
}

export interface ReviewSummary {
  approvedBy: string[];
  changesRequestedBy: string[];
  /** Approvals submitted for the current head commit. */
  approvalsOnHead: number;
  requiredApprovingReviews: number | null;
}

/** Latest decisive review per reviewer. Comments do not change a reviewer's decision; a dismissal clears it. */
export function summarizeReviews(reviews: readonly PullRequestReview[], headSha: string, requiredApprovingReviews: number | null): ReviewSummary {
  const latest = new Map<string, PullRequestReview>();
  const ordered = [...reviews].sort((left, right) => (left.submittedAt ?? '').localeCompare(right.submittedAt ?? ''));
  for (const review of ordered) {
    if (review.reviewer === null || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    if (review.state === 'DISMISSED') latest.delete(review.reviewer);
    else latest.set(review.reviewer, review);
  }
  const decisions = [...latest.entries()];
  return {
    approvedBy: decisions.filter(([, review]) => review.state === 'APPROVED').map(([reviewer]) => reviewer).sort(),
    changesRequestedBy: decisions.filter(([, review]) => review.state === 'CHANGES_REQUESTED').map(([reviewer]) => reviewer).sort(),
    approvalsOnHead: decisions.filter(([, review]) => review.state === 'APPROVED' && review.commitId === headSha).length,
    requiredApprovingReviews,
  };
}
