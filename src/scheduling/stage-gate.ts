import type { DateTime } from 'luxon';
import type { OrchestratorConfig } from '../config/schema.js';
import type { OperationType, ScheduleOverride, TaskState } from '../types/domain.js';
import { operatingHoursFor } from './operating-hours.js';

/** Stages that the scheduler can execute through a stage handler, and the schedule category each one consumes. */
export const executableStageOperations: Readonly<Partial<Record<TaskState, OperationType>>> = {
  ANALYZING: 'ANALYSIS',
  READY: 'IMPLEMENTATION',
  IMPLEMENTING: 'IMPLEMENTATION',
  TESTING: 'QUALITY_GATE',
  FIXING: 'FIX',
  REVIEWING: 'REVIEW',
  PR_CREATED: 'DELIVERY',
  WAITING_CI: 'CI_CHECK',
  READY_FOR_HUMAN_REVIEW: 'CI_CHECK',
};

/** Deterministic operations that do not consume AI capacity. */
const mechanicalOperations: readonly OperationType[] = ['QUALITY_GATE', 'DELIVERY', 'CI_CHECK'];

export interface StageGateDecision {
  permitted: boolean;
  operation: OperationType;
  mechanical: boolean;
  reason: 'OVERRIDE_ENABLED' | 'OVERRIDE_DISABLED' | 'MECHANICAL_OUTSIDE_HOURS' | 'SCHEDULE_DISABLED' | 'OUTSIDE_WINDOW' | 'INSUFFICIENT_REMAINING_TIME' | 'OPEN';
  minutesRemaining: number;
}

export function isMechanicalOperation(operation: OperationType): boolean {
  return mechanicalOperations.includes(operation);
}

/**
 * Decides whether a new unit of work may start now.
 * `normal` follows the YAML schedule, `enabled` permits all work, and `disabled` stops new AI work while mechanical
 * operations follow `allowMechanicalOperationsOutsideHours`.
 */
export function operationGate(
  config: OrchestratorConfig,
  operation: OperationType,
  override: ScheduleOverride,
  now?: DateTime,
): StageGateDecision {
  const mechanical = isMechanicalOperation(operation);
  if (override === 'enabled') {
    return { permitted: true, operation, mechanical, reason: 'OVERRIDE_ENABLED', minutesRemaining: Number.POSITIVE_INFINITY };
  }

  const hours = operatingHoursFor(config, operation, now === undefined ? {} : { now });
  const mechanicalAllowed = mechanical && config.schedule.allowMechanicalOperationsOutsideHours;
  if (override === 'disabled') {
    return mechanicalAllowed
      ? { permitted: true, operation, mechanical, reason: 'MECHANICAL_OUTSIDE_HOURS', minutesRemaining: hours.minutesRemaining }
      : { permitted: false, operation, mechanical, reason: 'OVERRIDE_DISABLED', minutesRemaining: hours.minutesRemaining };
  }

  if (hours.canStart) {
    // A new AI step also needs the generic step guard, which can be stricter than the per-stage minimum.
    if (!mechanical && hours.minutesRemaining < config.schedule.startNewStepIfRemainingMinutesAtLeast) {
      return { permitted: false, operation, mechanical, reason: 'INSUFFICIENT_REMAINING_TIME', minutesRemaining: hours.minutesRemaining };
    }
    return { permitted: true, operation, mechanical, reason: hours.reason, minutesRemaining: hours.minutesRemaining };
  }
  if (mechanicalAllowed) {
    return { permitted: true, operation, mechanical, reason: 'MECHANICAL_OUTSIDE_HOURS', minutesRemaining: hours.minutesRemaining };
  }
  return { permitted: false, operation, mechanical, reason: hours.reason, minutesRemaining: hours.minutesRemaining };
}

export function stageGate(config: OrchestratorConfig, stage: TaskState, override: ScheduleOverride, now?: DateTime): StageGateDecision | undefined {
  const operation = executableStageOperations[stage];
  return operation === undefined ? undefined : operationGate(config, operation, override, now);
}

/** Whether a running stage should be interrupted because the schedule closed and the configuration does not let it finish. */
export function shouldInterruptRunningStage(config: OrchestratorConfig, stage: TaskState, override: ScheduleOverride, now?: DateTime): boolean {
  if (config.schedule.finishCurrentStep) return false;
  const operation = executableStageOperations[stage];
  if (operation === undefined) return false;
  const mechanical = isMechanicalOperation(operation);
  if (override === 'enabled') return false;
  if (mechanical && config.schedule.allowMechanicalOperationsOutsideHours) return false;
  if (override === 'disabled') return true;
  return !operatingHoursFor(config, operation, now === undefined ? {} : { now }).isOpen;
}
