import type { PauseReason, TaskState } from '../types/domain.js';
import { canCancel, transitionMap } from '../types/domain.js';

export class InvalidTransitionError extends Error {
  constructor(public readonly from: TaskState, public readonly to: TaskState) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface StateTransition {
  from: TaskState;
  to: TaskState;
  reason?: string;
  resumeState?: TaskState;
  pauseReason?: PauseReason;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitionMap[from].includes(to) || (to === 'CANCELLED' && canCancel(from));
}

export function transitionTask(
  current: TaskState,
  next: TaskState,
  details: Omit<StateTransition, 'from' | 'to'> = {},
): StateTransition {
  if (!canTransition(current, next)) {
    throw new InvalidTransitionError(current, next);
  }

  if (next === 'PAUSED_SCHEDULE' && !details.resumeState) {
    throw new Error('PAUSED_SCHEDULE transitions require resumeState');
  }

  if (next === 'PAUSED_LIMIT' && !details.resumeState) {
    throw new Error('PAUSED_LIMIT transitions require resumeState');
  }

  if ((next === 'PAUSED_SCHEDULE' || next === 'PAUSED_LIMIT') && details.resumeState && !canTransition(next, details.resumeState)) {
    throw new Error(`${next} cannot resume to ${details.resumeState}`);
  }

  return { from: current, to: next, ...details };
}

export function resumableState(transition: StateTransition): TaskState | undefined {
  if (transition.to !== 'PAUSED_SCHEDULE' && transition.to !== 'PAUSED_LIMIT') {
    return undefined;
  }
  return transition.resumeState;
}
