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
] as const;

export type TaskState = (typeof taskStates)[number];

export type PauseReason = 'OPERATING_HOURS_ENDED' | 'CODEX_USAGE_LIMIT' | 'RATE_LIMIT';

export type OperationType =
  | 'TASK_DISCOVERY'
  | 'ANALYSIS'
  | 'IMPLEMENTATION'
  | 'FIX'
  | 'REVIEW'
  | 'DELIVERY'
  | 'CI_CHECK';

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
  ANALYZING: ['READY', 'BLOCKED', 'PAUSED_SCHEDULE'],
  READY: ['IMPLEMENTING', 'BLOCKED', 'PAUSED_SCHEDULE'],
  IMPLEMENTING: ['TESTING', 'FIXING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  TESTING: ['REVIEWING', 'FIXING', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  FIXING: ['TESTING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  REVIEWING: ['PR_CREATED', 'FIXING', 'PAUSED_LIMIT', 'PAUSED_SCHEDULE', 'BLOCKED', 'FAILED'],
  PR_CREATED: ['WAITING_CI', 'BLOCKED'],
  WAITING_CI: ['READY_FOR_HUMAN_REVIEW', 'BLOCKED'],
  READY_FOR_HUMAN_REVIEW: ['COMPLETED'],
  PAUSED_SCHEDULE: ['ANALYZING', 'READY', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING', 'BLOCKED'],
  PAUSED_LIMIT: ['IMPLEMENTING', 'FIXING', 'REVIEWING', 'BLOCKED'],
  BLOCKED: ['QUEUED'],
  FAILED: ['QUEUED', 'BLOCKED'],
  COMPLETED: [],
};
