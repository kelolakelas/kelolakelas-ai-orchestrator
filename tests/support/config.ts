import { validateConfig, type OrchestratorConfig } from '../../src/config/schema.js';

const closedDay = { enabled: false, windows: [] };

/** Monday to Friday 08:00-18:00 Asia/Jakarta unless `schedule.enabled` is false. */
export function testConfig(overrides: { orchestrator?: Record<string, unknown>; schedule?: Record<string, unknown> } = {}): OrchestratorConfig {
  const workday = { enabled: true, windows: [{ start: '08:00', end: '18:00' }] };
  return validateConfig({
    timezone: 'Asia/Jakarta',
    orchestrator: { maxConcurrentTasks: 1, pollingIntervalSeconds: 60, ...overrides.orchestrator },
    schedule: {
      enabled: true,
      days: { monday: workday, tuesday: workday, wednesday: workday, thursday: workday, friday: workday, saturday: closedDay, sunday: closedDay },
      ...overrides.schedule,
    },
    linear: { teamKey: 'KEL', requiredLabels: ['ai-ready'] },
    models: { analyzer: { tier: 'terra', effort: 'high' }, reviewer: { tier: 'terra', effort: 'high' }, tiers: { terra: { model: 'model' } } },
    limits: {},
  });
}

/** 2026-09-16 is a Wednesday. Times are Asia/Jakarta (UTC+7). */
export const insideHours = new Date('2026-09-16T10:00:00+07:00');
export const outsideHours = new Date('2026-09-16T20:00:00+07:00');
