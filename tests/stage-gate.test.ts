import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { canTransition, transitionTask } from '../src/orchestrator/state-machine.js';
import { operationGate, shouldInterruptRunningStage, stageGate } from '../src/scheduling/stage-gate.js';
import { insideHours, outsideHours, testConfig } from './support/config.js';

const zone = (date: Date) => DateTime.fromJSDate(date).setZone('Asia/Jakarta');

describe('stage gate', () => {
  const config = testConfig();

  it('permits AI stages only inside operating hours under the normal override', () => {
    expect(stageGate(config, 'ANALYZING', 'normal', zone(insideHours))?.permitted).toBe(true);
    expect(stageGate(config, 'ANALYZING', 'normal', zone(outsideHours))).toMatchObject({ permitted: false, reason: 'OUTSIDE_WINDOW' });
    expect(operationGate(config, 'TASK_DISCOVERY', 'normal', zone(outsideHours)).permitted).toBe(false);
  });

  it('lets mechanical stages follow allowMechanicalOperationsOutsideHours', () => {
    expect(stageGate(config, 'WAITING_CI', 'normal', zone(outsideHours))).toMatchObject({ permitted: true, reason: 'MECHANICAL_OUTSIDE_HOURS' });
    const strict = testConfig({ schedule: { allowMechanicalOperationsOutsideHours: false } });
    expect(stageGate(strict, 'WAITING_CI', 'normal', zone(outsideHours))?.permitted).toBe(false);
  });

  it('applies the startNewStep guard to AI stages near the end of a window', () => {
    const nearClose = zone(new Date('2026-09-16T17:50:00+07:00'));
    const guarded = testConfig({ schedule: { minimumRemainingMinutesForAnalysis: 0, startNewStepIfRemainingMinutesAtLeast: 20 } });
    expect(stageGate(guarded, 'ANALYZING', 'normal', nearClose)).toMatchObject({ permitted: false, reason: 'INSUFFICIENT_REMAINING_TIME' });
    expect(stageGate(guarded, 'TESTING', 'normal', nearClose)?.permitted).toBe(true);
  });

  it('honours enabled and disabled schedule overrides', () => {
    expect(stageGate(config, 'IMPLEMENTING', 'enabled', zone(outsideHours))?.permitted).toBe(true);
    expect(stageGate(config, 'IMPLEMENTING', 'disabled', zone(insideHours))).toMatchObject({ permitted: false, reason: 'OVERRIDE_DISABLED' });
    expect(stageGate(config, 'WAITING_CI', 'disabled', zone(insideHours))?.permitted).toBe(true);
  });

  it('returns no gate for states that have no executable stage', () => {
    expect(stageGate(config, 'QUEUED', 'normal', zone(insideHours))).toBeUndefined();
    expect(stageGate(config, 'COMPLETED', 'normal', zone(insideHours))).toBeUndefined();
  });

  it('interrupts a running AI stage only when finishCurrentStep is false', () => {
    expect(shouldInterruptRunningStage(config, 'IMPLEMENTING', 'normal', zone(outsideHours))).toBe(false);
    const eager = testConfig({ schedule: { finishCurrentStep: false } });
    expect(shouldInterruptRunningStage(eager, 'IMPLEMENTING', 'normal', zone(outsideHours))).toBe(true);
    expect(shouldInterruptRunningStage(eager, 'IMPLEMENTING', 'normal', zone(insideHours))).toBe(false);
    expect(shouldInterruptRunningStage(eager, 'WAITING_CI', 'normal', zone(outsideHours))).toBe(false);
    expect(shouldInterruptRunningStage(eager, 'IMPLEMENTING', 'disabled', zone(insideHours))).toBe(true);
  });
});

describe('Phase 3 state machine and configuration', () => {
  it('allows cancellation from every non-terminal state only', () => {
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('WAITING_CI', 'CANCELLED')).toBe(true);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
  });

  it('rejects a pause whose resumeState the paused state cannot resume to', () => {
    expect(() => transitionTask('TESTING', 'PAUSED_SCHEDULE', { resumeState: 'PR_CREATED' })).toThrow('cannot resume');
    expect(transitionTask('ANALYZING', 'PAUSED_LIMIT', { resumeState: 'ANALYZING' }).resumeState).toBe('ANALYZING');
  });

  it('requires heartbeats to fit twice inside the lease', () => {
    const base = testConfig();
    expect(() => validateConfig({ ...base, orchestrator: { ...base.orchestrator, leaseDurationSeconds: 60, heartbeatIntervalSeconds: 45 } }))
      .toThrow(/half of leaseDurationSeconds/);
  });
});
