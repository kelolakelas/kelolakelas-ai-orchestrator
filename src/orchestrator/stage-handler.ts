import type { PersistedTask } from '../repositories/task.repository.js';
import type { PauseReason, TaskState } from '../types/domain.js';

/**
 * Normalized result of one stage. Handlers never persist state themselves; the scheduler applies the outcome through
 * the state machine while it still holds the task lease.
 */
export type StageOutcome =
  | { kind: 'advance'; to: TaskState; reason?: string }
  | { kind: 'pause-limit'; pauseReason: Exclude<PauseReason, 'OPERATING_HOURS_ENDED'>; resumeAfter?: Date; reason?: string }
  /** The handler observed `signal.aborted`, recorded any checkpoint it needs, and stopped at a safe point. */
  | { kind: 'interrupted' };

export type StageAbortReason = 'shutdown' | 'schedule' | 'operator' | 'lease-lost';

export interface StageContext {
  task: PersistedTask;
  /** Aborted on shutdown, schedule closure (when `finishCurrentStep` is false), operator action, or lease loss. */
  signal: AbortSignal;
  checkpoint(checkpointKey: string, payload: Record<string, unknown>): Promise<void>;
  getCheckpoint(checkpointKey: string): Promise<Record<string, unknown> | undefined>;
  log(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Executes one stage. A handler must be idempotent with respect to its own checkpoints: a stage can run again after a
 * pause, graceful shutdown, or operator retry.
 */
export interface StageHandler {
  run(context: StageContext): Promise<StageOutcome>;
}

export type StageHandlers = Partial<Record<TaskState, StageHandler>>;
