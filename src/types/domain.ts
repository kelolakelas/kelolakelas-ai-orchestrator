export const taskStates = [
  'QUEUED',
  'ANALYZING',
  'READY',
  'IMPLEMENTING',
  'TESTING',
  'FIXING',
  'REVIEWING',
  'PR_CREATED',
  'WAITING_CI',
  'READY_FOR_HUMAN_REVIEW',
  'PAUSED_SCHEDULE',
  'PAUSED_LIMIT',
  'BLOCKED',
  'FAILED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type TaskState = (typeof taskStates)[number];

/**
 * Why a task is parked. `USAGE_LIMIT` is provider-neutral; `CODEX_USAGE_LIMIT` is the pre-registry value and is still
 * read, so rows written before the provider registry existed keep pausing and resuming correctly.
 */
export type PauseReason = 'OPERATING_HOURS_ENDED' | 'USAGE_LIMIT' | 'CODEX_USAGE_LIMIT' | 'RATE_LIMIT' | 'REMOTE_UNAVAILABLE';

/** Pause reasons that hold the execution lane until `resumeAfter`, whatever provider reported them. */
export const providerLimitPauses: readonly PauseReason[] = ['USAGE_LIMIT', 'CODEX_USAGE_LIMIT', 'RATE_LIMIT'];

export function isProviderLimitPause(reason: PauseReason | null | undefined): boolean {
  return reason !== null && reason !== undefined && providerLimitPauses.includes(reason);
}

export type OperationType =
  | 'TASK_DISCOVERY'
  | 'ANALYSIS'
  | 'IMPLEMENTATION'
  | 'FIX'
  | 'REVIEW'
  | 'QUALITY_GATE'
  | 'DELIVERY'
  | 'CI_CHECK';

export type ScheduleOverride = 'normal' | 'enabled' | 'disabled';

/** Per-task bounded retry counters, each incremented atomically with the transition that consumes an attempt. */
export type AttemptCounter = 'implementationAttempts' | 'qualityFixAttempts' | 'reviewAttempts';

/**
 * Delivery states observe external systems (Git remotes, GitHub, Linear) and can wait days for people. They run in their
 * own claim lane so a pull request awaiting review never occupies a slot of `maxConcurrentTasks`.
 */
export const deliveryStates: readonly TaskState[] = ['PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW'];

export type ClaimLane = 'execution' | 'delivery';

export function claimLaneOf(state: TaskState): ClaimLane {
  return deliveryStates.includes(state) ? 'delivery' : 'execution';
}

/** States that carry no further work and never hold a lease. */
export const terminalStates: readonly TaskState[] = ['COMPLETED', 'CANCELLED'];

export interface TaskRecord {
  id: string;
  linearIssueId: string;
  state: TaskState;
  resumeState?: TaskState;
  pauseReason?: PauseReason;
  pausedAt?: string;
  implementationAttempts: number;
  qualityFixAttempts: number;
  reviewAttempts: number;
}

export const transitionMap: Readonly<Record<TaskState, readonly TaskState[]>> = {
  QUEUED: ['ANALYZING', 'BLOCKED'],
  ANALYZING: ['READY', 'BLOCKED', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE'],
  READY: ['IMPLEMENTING', 'BLOCKED', 'PAUSED_SCHEDULE'],
  // IMPLEMENTING -> READY retries a rejected implementation attempt through the schedule gate with an escalated model.
  IMPLEMENTING: ['TESTING', 'READY', 'FIXING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  TESTING: ['REVIEWING', 'FIXING', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  FIXING: ['TESTING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  REVIEWING: ['PR_CREATED', 'FIXING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  PR_CREATED: ['WAITING_CI', 'BLOCKED'],
  WAITING_CI: ['READY_FOR_HUMAN_REVIEW', 'BLOCKED'],
  // READY_FOR_HUMAN_REVIEW -> WAITING_CI re-observes required checks after the pull request head moves, for example when
  // a reviewer updates the branch from the base branch.
  READY_FOR_HUMAN_REVIEW: ['COMPLETED', 'WAITING_CI', 'BLOCKED'],
  PAUSED_SCHEDULE: ['ANALYZING', 'READY', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING', 'BLOCKED'],
  PAUSED_LIMIT: ['ANALYZING', 'IMPLEMENTING', 'FIXING', 'REVIEWING', 'BLOCKED'],
  BLOCKED: ['QUEUED'],
  FAILED: ['QUEUED', 'BLOCKED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Operator cancellation is permitted from every non-terminal state. */
export function canCancel(state: TaskState): boolean {
  return !terminalStates.includes(state);
}
