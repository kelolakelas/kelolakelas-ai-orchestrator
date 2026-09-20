import { DateTime } from 'luxon';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { taskComplexityEnum } from '../src/db/schema.js';
import { loggerOptions } from '../src/observability/logger.js';
import { canRetry } from '../src/orchestrator/retry-policy.js';
import { canTransition, InvalidTransitionError, transitionTask } from '../src/orchestrator/state-machine.js';
import { escalationStep } from '../src/routing/escalation-policy.js';
import { selectModel } from '../src/routing/model-router.js';
import { operatingHoursFor } from '../src/scheduling/operating-hours.js';

const config = validateConfig({
  timezone: 'Asia/Jakarta',
  schedule: {
    enabled: true,
    allowMechanicalOperationsOutsideHours: true,
    finishCurrentStep: true,
    startNewStepIfRemainingMinutesAtLeast: 20,
    minimumRemainingMinutesForNewTask: 45,
    minimumRemainingMinutesForAnalysis: 20,
    minimumRemainingMinutesForImplementation: 45,
    minimumRemainingMinutesForReview: 20,
    days: {
      monday: { enabled: true, windows: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '18:00' }] },
      tuesday: { enabled: true, windows: [{ start: '22:00', end: '03:00' }] },
      wednesday: { enabled: false, windows: [] },
      thursday: { enabled: false, windows: [] },
      friday: { enabled: false, windows: [] },
      saturday: { enabled: false, windows: [] },
      sunday: { enabled: false, windows: [] },
    },
  },
  linear: { teamKey: 'KEL', requiredLabels: ['ai-ready'], excludedLabels: ['blocked'] },
  models: {
    analyzer: { tier: 'terra', effort: 'high' },
    reviewer: { tier: 'terra', effort: 'high' },
    tiers: {
      luna: { model: 'luna-model' }, terra: { model: 'terra-model' }, sol: { model: 'sol-model' },
    },
  },
  limits: { maxImplementationAttempts: 2, maxQualityFixAttempts: 3, maxReviewCycles: 1 },
});

const at = (iso: string) => DateTime.fromISO(iso, { zone: config.timezone });

describe('state machine', () => {
  it('allows the normal workflow and rejects skipped stages', () => {
    expect(canTransition('QUEUED', 'ANALYZING')).toBe(true);
    expect(canTransition('ANALYZING', 'IMPLEMENTING')).toBe(false);
    expect(() => transitionTask('ANALYZING', 'IMPLEMENTING')).toThrow(InvalidTransitionError);
  });

  it('requires a resumable state for pauses', () => {
    expect(() => transitionTask('IMPLEMENTING', 'PAUSED_SCHEDULE')).toThrow('resumeState');
    expect(transitionTask('IMPLEMENTING', 'PAUSED_SCHEDULE', { resumeState: 'IMPLEMENTING' }).resumeState).toBe('IMPLEMENTING');
  });
});

describe('configuration validation', () => {
  it('rejects invalid IANA timezones and missing model tiers', () => {
    expect(() => validateConfig({ ...config, timezone: 'Asia/Not-A-Timezone' })).toThrow(/valid IANA timezone/);

    const missingTier = structuredClone(config);
    missingTier.models.analyzer.tier = 'missing';
    expect(() => validateConfig(missingTier)).toThrow(/configured model tier/);
  });
});

describe('structured logging', () => {
  it('redacts configured credential fields', () => {
    let output = '';
    const logger = pino(loggerOptions, { write: (chunk: string) => {
      output += chunk;
      return true;
    } });
    const secret = 'never-log-this-token';

    logger.info({
      authorization: `Bearer ${secret}`,
      environment: { LINEAR_API_KEY: secret },
      headers: { 'x-api-key': secret },
    }, 'Credential redaction test');

    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });
});

describe('model policy', () => {
  // This configuration routes without running agents, so no provider is in force and routing records that fact.
  const unrouted = { provider: 'unconfigured' };

  it('maps every complexity deterministically to its initial model selection', () => {
    expect(selectModel(config, 'very-low')).toEqual({ ...unrouted, tier: 'luna', model: 'luna-model', effort: 'medium' });
    expect(selectModel(config, 'low')).toEqual({ ...unrouted, tier: 'luna', model: 'luna-model', effort: 'high' });
    expect(selectModel(config, 'medium')).toEqual({ ...unrouted, tier: 'terra', model: 'terra-model', effort: 'medium' });
    expect(selectModel(config, 'high')).toEqual({ ...unrouted, tier: 'terra', model: 'terra-model', effort: 'high' });
    expect(selectModel(config, 'very-high')).toEqual({ ...unrouted, tier: 'sol', model: 'sol-model', effort: 'medium' });
    expect(selectModel(config, 'critical')).toEqual({ ...unrouted, tier: 'sol', model: 'sol-model', effort: 'high' });
  });

  it('starts with selectModel and allows max effort only on a retry', () => {
    expect(escalationStep(config, 'critical', 1)).toEqual(selectModel(config, 'critical'));
    expect(escalationStep(config, 'critical', 2)).toEqual({ ...unrouted, tier: 'sol', model: 'sol-model', effort: 'max' });
    expect(escalationStep(config, 'medium', 3)).toBeUndefined();
    expect(escalationStep(config, 'medium', 0)).toBeUndefined();
  });

  it('enforces retry ceilings', () => {
    expect(canRetry(config, 'implementation', 1)).toBe(true);
    expect(canRetry(config, 'implementation', 2)).toBe(false);
    expect(canRetry(config, 'review', 1)).toBe(false);
  });
});

describe('task persistence schema', () => {
  it('restricts persisted task complexity to the planning contract enum', () => {
    expect(taskComplexityEnum.enumValues).toEqual([
      'very-low', 'low', 'medium', 'high', 'very-high', 'critical',
    ]);
  });
});

describe('operating hours', () => {
  it('handles split windows and minimum remaining time', () => {
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-14T11:30:00') }).canStart).toBe(true);
    expect(operatingHoursFor(config, 'IMPLEMENTATION', { now: at('2026-09-14T17:30:00') }).reason).toBe('INSUFFICIENT_REMAINING_TIME');
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-14T12:30:00') }).isOpen).toBe(false);
  });

  it('handles disabled days and timezone conversion', () => {
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-16T10:00:00') }).isOpen).toBe(false);
    const utcInstant = DateTime.fromISO('2026-09-14T02:00:00Z');
    expect(operatingHoursFor(config, 'ANALYSIS', { now: utcInstant.setZone(config.timezone) }).isOpen).toBe(true);
  });

  it('handles overnight windows across midnight', () => {
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-15T22:30:00') }).isOpen).toBe(true);
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-16T02:30:00') }).isOpen).toBe(true);
    expect(operatingHoursFor(config, 'ANALYSIS', { now: at('2026-09-16T04:00:00') }).isOpen).toBe(false);
  });
});
