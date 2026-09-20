import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import * as schema from '../src/db/schema.js';
import { OrchestratorMetrics } from '../src/observability/orchestrator-metrics.js';
import { RetentionMaintenance } from '../src/operations/retention.js';
import { Scheduler, type MaintenanceTask, type SchedulerOptions } from '../src/orchestrator/scheduler.js';
import type { StageHandlers } from '../src/orchestrator/stage-handler.js';
import { MetricsRepository } from '../src/repositories/metrics.repository.js';
import { OperatorRepository } from '../src/repositories/operator.repository.js';
import { RetentionRepository } from '../src/repositories/retention.repository.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { insideHours, testConfig } from './support/config.js';
import { resetDatabase } from './support/database.js';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;
type Repository = 'web' | 'billing' | 'academic';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describeIntegration('production operations with PostgreSQL', () => {
  let pool: pg.Pool;
  let tasks: TaskRepository;
  let operator: OperatorRepository;
  const context = { actor: 'ops@example.test', reason: 'Phase 7 integration test' };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzle(pool, { schema });
    tasks = new TaskRepository(db);
    operator = new OperatorRepository(db);
  });

  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(() => resetDatabase(pool));

  let sequence = 0;
  async function createQueued(repositories: Repository[]): Promise<string> {
    sequence += 1;
    const task = await tasks.createTask({
      linearIssueId: `ops-issue-${sequence}`,
      linearIdentifier: `KEL-${900 + sequence}`,
      contractSnapshot: { sequence },
      complexity: 'low',
      workUnits: repositories.map((repository) => ({ repository })),
    });
    return task.id;
  }

  function config(orchestrator: Record<string, unknown> = {}, repositories: Record<string, unknown> = {}) {
    const base = testConfig();
    return validateConfig({
      timezone: base.timezone,
      orchestrator: { maxConcurrentTasks: 5, ...orchestrator },
      schedule: { enabled: false, days: {} },
      linear: { teamKey: 'KEL' },
      models: base.models,
      limits: {},
      repositories,
    });
  }

  function worker(workerId: string, handlers: StageHandlers, options: Partial<SchedulerOptions> = {}): Scheduler {
    return new Scheduler({
      config: testConfig({ schedule: { enabled: false } }),
      linear: { listIssues: async () => [] },
      tasks,
      operator,
      workerId,
      dryRun: false,
      log: () => undefined,
      handlers,
      clock: () => insideHours,
      ...options,
    });
  }

  async function transitionCount(taskId: string): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM state_transitions WHERE task_id = $1', [taskId]);
    return Number(result.rows[0]?.count);
  }

  const repository = (path: string) => ({ path, github: 'kelolakelas/example' });

  describe('kill switch', () => {
    it('interrupts running stages, parks tasks with their state and checkpoints, stops maintenance and claims, and resumes after release', async () => {
      const taskId = await createQueued(['web']);
      const waitingId = await createQueued(['billing']);
      const started = deferred();
      let runs = 0;
      const maintenance: MaintenanceTask = { name: 'probe', run: vi.fn(async () => undefined) };
      const handlers: StageHandlers = {
        ANALYZING: {
          run: async ({ signal, checkpoint, getCheckpoint }) => {
            runs += 1;
            if (await getCheckpoint('halfway') !== undefined) return { kind: 'advance', to: 'READY' };
            await checkpoint('halfway', { at: 'analysis' });
            started.resolve();
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            return { kind: 'interrupted' };
          },
        },
      };
      const log = vi.fn();
      const instance = worker('worker-kill', handlers, {
        config: testConfig({ orchestrator: { maxConcurrentTasks: 1 }, schedule: { enabled: false } }),
        maintenance: [maintenance],
        log,
        timing: { heartbeatIntervalMs: 20 },
      });

      await instance.runOnce();
      await started.promise;
      expect(vi.mocked(maintenance.run)).toHaveBeenCalledTimes(1);
      const transitionsBefore = await transitionCount(taskId);

      await operator.setKillSwitch(true, context);
      await instance.drain();
      const parked = await tasks.getTask(taskId);
      expect(parked).toMatchObject({ state: 'ANALYZING', leaseOwner: null, requiresManualIntervention: false, lastError: null });
      expect(await tasks.getCheckpoint(taskId, 'halfway')).toEqual({ at: 'analysis' });
      expect(await transitionCount(taskId)).toBe(transitionsBefore);
      expect(log).toHaveBeenCalledWith('task_parked', expect.objectContaining({ taskId, reason: 'kill_switch' }));

      await instance.runOnce();
      await instance.drain();
      expect(vi.mocked(maintenance.run)).toHaveBeenCalledTimes(1);
      expect(await tasks.getTask(waitingId)).toMatchObject({ state: 'QUEUED', leaseOwner: null });
      expect(instance.status()).toMatchObject({ controls: { killSwitch: true }, killSwitchSource: 'database' });

      await operator.setKillSwitch(false, context);
      await instance.runOnce();
      await instance.drain();
      expect(await tasks.getTask(taskId)).toMatchObject({ state: 'READY' });
      expect(runs).toBe(2);
      const actions = await pool.query<{ action: string; actor: string; reason: string }>('SELECT action, actor, reason FROM operator_actions ORDER BY created_at');
      expect(actions.rows).toEqual([
        { action: 'ENGAGE_KILL_SWITCH', ...context },
        { action: 'RELEASE_KILL_SWITCH', ...context },
      ]);
    });

    it('applies the switch to this worker immediately through refreshControls and honours the environment override', async () => {
      const taskId = await createQueued(['web']);
      const started = deferred();
      const instance = worker('worker-refresh', {
        ANALYZING: {
          run: async ({ signal }) => {
            started.resolve();
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            return { kind: 'interrupted' };
          },
        },
      }, { timing: { heartbeatIntervalMs: 60_000 } });
      await instance.runOnce();
      await started.promise;
      await operator.setKillSwitch(true, context);
      await instance.refreshControls();
      await instance.drain();
      expect(await tasks.getTask(taskId)).toMatchObject({ state: 'ANALYZING', leaseOwner: null });
      await operator.setKillSwitch(false, context);

      const forced = worker('worker-forced', { ANALYZING: { run: async () => ({ kind: 'advance', to: 'READY' }) } }, { forceKillSwitch: true });
      await forced.runOnce();
      await forced.drain();
      expect(await tasks.getTask(taskId)).toMatchObject({ state: 'ANALYZING', leaseOwner: null });
      expect(forced.status()).toMatchObject({ killSwitchSource: 'environment', controls: { killSwitch: true } });
    });
  });

  describe('claim limits', () => {
    it('limits leased execution tasks per repository across workers', async () => {
      const webFirst = await createQueued(['web']);
      const webSecond = await createQueued(['web', 'billing']);
      const billingOnly = await createQueued(['billing']);
      const gate = deferred();
      const handlers: StageHandlers = { ANALYZING: { run: async () => { await gate.promise; return { kind: 'advance', to: 'READY' }; } } };
      const limited = config({}, { web: { ...repository('/srv/web'), maxConcurrentTasks: 1 }, billing: repository('/srv/billing') });
      const first = worker('worker-repo-a', handlers, { config: limited });
      const second = worker('worker-repo-b', handlers, { config: limited });

      await first.runOnce();
      await second.runOnce();
      const leased = await pool.query<{ id: string }>('SELECT id FROM tasks WHERE lease_owner IS NOT NULL ORDER BY created_at');
      expect(leased.rows.map((row) => row.id)).toEqual([webFirst, billingOnly]);
      gate.resolve();
      await Promise.all([first.drain(), second.drain()]);

      await first.runOnce();
      await first.drain();
      expect(await tasks.getTask(webSecond)).toMatchObject({ state: 'READY' });
    });

    it('starts only rollout repositories and at most maxNewTasksPerDay new tasks, without stranding started work', async () => {
      const billing = await createQueued(['billing']);
      const webFirst = await createQueued(['web']);
      const webSecond = await createQueued(['web']);
      const mixed = await createQueued(['web', 'academic']);
      let clock = insideHours;
      const canary = config({ rollout: { repositories: ['web'], maxNewTasksPerDay: 1 } });
      const instance = worker('worker-canary', { ANALYZING: { run: async () => ({ kind: 'advance', to: 'READY' }) }, READY: { run: async () => ({ kind: 'advance', to: 'BLOCKED', reason: 'end of test flow' }) } }, { config: canary, clock: () => clock });

      await instance.runOnce();
      await instance.drain();
      await instance.runOnce();
      await instance.drain();
      const states = async () => Promise.all([billing, webFirst, webSecond, mixed].map(async (id) => (await tasks.getTask(id))?.state));
      expect(await states()).toEqual(['QUEUED', 'BLOCKED', 'QUEUED', 'QUEUED']);

      clock = new Date(Date.now() + 25 * 60 * 60 * 1_000);
      await instance.runOnce();
      await instance.drain();
      expect(await states()).toEqual(['QUEUED', 'BLOCKED', 'BLOCKED', 'QUEUED']);
    });
  });

  it('bounds lane refills per tick so constantly claimable delivery work cannot starve execution or intake', async () => {
    for (let index = 0; index < 6; index += 1) {
      const id = await createQueued(['web']);
      await pool.query(`UPDATE tasks SET state = 'WAITING_CI' WHERE id = $1`, [id]);
    }
    const queued = await createQueued(['billing']);
    const listIssues = vi.fn(async () => []);
    const instance = worker('worker-refill', {
      ANALYZING: { run: async () => ({ kind: 'advance', to: 'READY' }) },
      // Each observation finishes at once and is claimable again immediately: an unbounded refill never ends.
      WAITING_CI: { run: async () => ({ kind: 'wait', until: new Date(0), reason: 'checks pending' }) },
    }, {
      config: testConfig({ orchestrator: { maxConcurrentDeliveryTasks: 2 }, schedule: { enabled: false } }),
      linear: { listIssues },
      // A claim slower than a stage, as on a busy database, lets claimed observations finish before the next claim.
      tasks: new Proxy(tasks, {
        get: (target, property, receiver) => property === 'claimNextTask'
          ? async (...args: Parameters<TaskRepository['claimNextTask']>) => { await new Promise((resolve) => setTimeout(resolve, 40)); return target.claimNextTask(...args); }
          : Reflect.get(target, property, receiver),
      }),
      timing: { pollIntervalMs: 300 },
    });

    const startedAt = Date.now();
    await instance.runOnce();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await instance.drain();
    expect(await tasks.getTask(queued)).toMatchObject({ state: 'READY' });
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  it('holds execution claims while the runner is usage limited and resumes after the hold', async () => {
    const limited = await createQueued(['web']);
    const other = await createQueued(['web']);
    let now = insideHours;
    const resumeAfter = new Date(insideHours.getTime() + 30 * 60_000);
    let first = true;
    const instance = worker('worker-backpressure', {
      ANALYZING: {
        run: async () => {
          if (first) {
            first = false;
            return { kind: 'pause-limit', pauseReason: 'USAGE_LIMIT', resumeAfter };
          }
          return { kind: 'advance', to: 'READY' };
        },
      },
    }, { config: testConfig({ orchestrator: { maxConcurrentTasks: 1 }, schedule: { enabled: false } }), clock: () => now });

    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(limited)).toMatchObject({ state: 'PAUSED_LIMIT' });
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(other)).toMatchObject({ state: 'QUEUED' });
    expect(instance.status().laneHolds.execution).toMatchObject({ until: resumeAfter, reason: 'runner USAGE_LIMIT' });

    now = new Date(resumeAfter.getTime() + 1_000);
    await instance.runOnce();
    await instance.drain();
    expect(instance.status().laneHolds).toEqual({});
    // Paused work resumes before new work starts.
    expect(await tasks.getTask(limited)).toMatchObject({ state: 'READY' });
    expect(await tasks.getTask(other)).toMatchObject({ state: 'QUEUED' });
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(other)).toMatchObject({ state: 'READY' });
  });

  it('exports queue age, stale leases, dwell time, and token usage without identifiers', async () => {
    const waiting = await createQueued(['web']);
    const stale = await createQueued(['billing']);
    await pool.query(`UPDATE tasks SET state = 'WAITING_CI' WHERE id = $1`, [waiting]);
    await pool.query(`INSERT INTO state_transitions (task_id, from_state, to_state, created_at) VALUES ($1, 'PR_CREATED', 'WAITING_CI', now() - interval '2 hours')`, [waiting]);
    await pool.query(`UPDATE tasks SET lease_owner = 'dead-worker', lease_expires_at = now() - interval '5 minutes' WHERE id = $1`, [stale]);
    await pool.query(`INSERT INTO task_attempts (task_id, stage, attempt, failure_category, input, usage, completed_at)
      VALUES ($1, 'IMPLEMENTING', 1, NULL, '{"model":{"provider":"primary","tier":"terra","model":"model-x"}}', '{"inputTokens":1000,"cachedInputTokens":400,"outputTokens":250,"reasoningOutputTokens":100}', now())`, [stale]);

    const metrics = new OrchestratorMetrics();
    metrics.applySnapshot(await new MetricsRepository(drizzle(pool, { schema })).snapshot(), {});
    const text = await metrics.registry.render();

    expect(text).toContain('orchestrator_tasks{state="WAITING_CI"} 1');
    expect(Number(/orchestrator_task_state_age_seconds_max\{state="WAITING_CI"\} (\d+)/.exec(text)?.[1])).toBeGreaterThanOrEqual(7_190);
    expect(text).toContain('orchestrator_leases_stale 1');
    expect(text).toContain('orchestrator_attempts_total{stage="IMPLEMENTING",category="succeeded"} 1');
    expect(text).toContain('orchestrator_model_tokens_total{model="model-x",provider="primary",kind="input"} 1000');
    expect(text).not.toContain(waiting);
    expect(text).not.toContain('KEL-');
  });

  it('prunes terminal-task artifacts and stale quarantines while keeping the audit record and retryable tasks', async () => {
    const completed = await createQueued(['web']);
    const blocked = await createQueued(['web']);
    const recent = await createQueued(['web']);
    for (const [id, state, age] of [[completed, 'COMPLETED', '120 days'], [blocked, 'BLOCKED', '120 days'], [recent, 'CANCELLED', '1 day']] as const) {
      await pool.query(`UPDATE tasks SET state = $2, updated_at = now() - $3::interval WHERE id = $1`, [id, state, age]);
      await pool.query(`INSERT INTO task_attempts (task_id, stage, attempt, result, evidence, usage) VALUES ($1, 'TESTING', 1, '{"ok":true}', '{"output":"tail"}', '{"inputTokens":1}')`, [id]);
      await pool.query(`INSERT INTO task_checkpoints (task_id, stage, checkpoint_key, payload) VALUES ($1, 'TESTING', 'quality-passed', '{"heads":{}}')`, [id]);
    }
    await pool.query(`INSERT INTO intake_quarantines (linear_issue_id, linear_identifier, reason, last_seen_at) VALUES ('old', 'KEL-1', 'bad', now() - interval '40 days'), ('new', 'KEL-2', 'bad', now())`);
    const scratch = mkdtempSync(join(tmpdir(), 'runner-scratch-'));
    mkdirSync(join(scratch, 'implementer-old'));
    mkdirSync(join(scratch, 'implementer-running'));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(join(scratch, 'implementer-old'), old, old);

    try {
      const removed: Record<string, number> = {};
      const retention = new RetentionMaintenance({
        config: config().retention,
        repository: new RetentionRepository(drizzle(pool, { schema })),
        runnerScratchRoot: scratch,
        log: () => undefined,
        onRemoved: (kind, count) => { removed[kind] = count; },
      });
      await retention.run();
      await retention.run();

      expect(removed).toEqual({ attemptEvidence: 1, checkpoints: 1, quarantines: 1, runnerScratch: 1 });
      const attempts = await pool.query<{ task_id: string; evidence: unknown; result: unknown; usage: unknown }>('SELECT task_id, evidence, result, usage FROM task_attempts');
      const byTask = new Map(attempts.rows.map((row) => [row.task_id, row]));
      expect(byTask.get(completed)).toMatchObject({ evidence: null, result: { ok: true }, usage: { inputTokens: 1 } });
      expect(byTask.get(blocked)?.evidence).toEqual({ output: 'tail' });
      expect(byTask.get(recent)?.evidence).toEqual({ output: 'tail' });
      expect(await tasks.getCheckpoint(blocked, 'quality-passed')).toBeDefined();
      expect(await tasks.getCheckpoint(completed, 'quality-passed')).toBeUndefined();
      expect(existsSync(join(scratch, 'implementer-old'))).toBe(false);
      expect(existsSync(join(scratch, 'implementer-running'))).toBe(true);
      expect((await pool.query('SELECT 1 FROM tasks')).rowCount).toBe(3);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
