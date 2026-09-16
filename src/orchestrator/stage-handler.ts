import type { PersistedTask } from '../repositories/task.repository.js';
import type { AttemptCounter, PauseReason, TaskState } from '../types/domain.js';

/**
 * Normalized result of one stage. Handlers never persist state themselves; the scheduler applies the outcome through
 * the state machine while it still holds the task lease.
 */
export type StageOutcome =
  | {
    kind: 'advance';
    to: TaskState;
    reason?: string;
    /** Consumes one bounded attempt atomically with the transition. */
    incrementCounter?: AttemptCounter;
    /** Operator-visible explanation persisted as `last_error`; `null` clears an earlier one. */
    lastError?: string | null;
    /** Stops automatic processing; use with `BLOCKED`. */
    requiresManualIntervention?: boolean;
  }
  | { kind: 'pause-limit'; pauseReason: Exclude<PauseReason, 'OPERATING_HOURS_ENDED'>; resumeAfter?: Date; reason?: string }
  /**
   * Keeps the current state and releases the lease until `until`, for example while required checks are pending or a
   * provider is briefly unavailable. No transition is recorded because the state does not change.
   */
  | { kind: 'wait'; until: Date; reason: string; lastError?: string | null }
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
