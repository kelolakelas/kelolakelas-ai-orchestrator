import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import { Scheduler, type SchedulerOptions } from '../src/orchestrator/scheduler.js';
import type { StageHandlers } from '../src/orchestrator/stage-handler.js';
import { OperatorRepository } from '../src/repositories/operator.repository.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { insideHours, outsideHours, testConfig } from './support/config.js';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describeIntegration('scheduler with PostgreSQL', () => {
  let pool: pg.Pool;
  let tasks: TaskRepository;
  let operator: OperatorRepository;
  const operatorContext = { actor: 'ops@example.test', reason: 'integration test' };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzle(pool, { schema });
    tasks = new TaskRepository(db);
    operator = new OperatorRepository(db);
  });

  // DELETE rather than TRUNCATE: TRUNCATE fsyncs new relation files per table, which can exceed hook timeouts on a busy disk.
  async function reset(): Promise<void> {
    await pool.query(`
      DELETE FROM operator_actions; DELETE FROM state_transitions; DELETE FROM task_checkpoints; DELETE FROM task_attempts;
      DELETE FROM external_operations; DELETE FROM task_dependencies; DELETE FROM task_work_units; DELETE FROM tasks;
      DELETE FROM intake_quarantines;
      UPDATE orchestrator_controls SET pause_new_work = false, schedule_override = 'normal';
    `);
  }

  afterAll(async () => {
    await reset();
    await pool.end();
  });

  beforeEach(reset);

  async function createQueued(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const task = await tasks.createTask({
        linearIssueId: `issue-${index}`,
        linearIdentifier: `KEL-${index}`,
        contractSnapshot: { index },
        complexity: 'low',
        workUnits: [{ repository: 'web' }],
      });
      ids.push(task.id);
    }
    return ids;
  }

  function worker(workerId: string, handlers: StageHandlers, options: Partial<SchedulerOptions> = {}): Scheduler {
    return new Scheduler({
      config: testConfig(),
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

  async function transitions(taskId: string): Promise<string[]> {
    const result = await pool.query<{ from_state: string | null; to_state: string }>(
      'SELECT from_state, to_state FROM state_transitions WHERE task_id = $1 ORDER BY created_at, id',
      [taskId],
    );
    return result.rows.map((row) => `${row.from_state}->${row.to_state}`);
  }

  async function leasedCount(): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM tasks WHERE lease_owner IS NOT NULL');
    return Number(result.rows[0]?.count);
  }

  it('never exceeds maxConcurrentTasks across concurrent worker processes', async () => {
    await createQueued(5);
    const gate = deferred();
    const handlers: StageHandlers = { ANALYZING: { run: async () => { await gate.promise; return { kind: 'advance', to: 'READY' }; } } };
    const config = testConfig({ orchestrator: { maxConcurrentTasks: 2 } });
    const workers = ['worker-a', 'worker-b', 'worker-c'].map((id) => worker(id, handlers, { config }));

    await Promise.all(workers.map((instance) => instance.runOnce()));
    await Promise.all(workers.map((instance) => instance.runOnce()));
    expect(await leasedCount()).toBe(2);
    expect(workers.reduce((total, instance) => total + instance.status().inFlight.length, 0)).toBe(2);

    gate.resolve();
    await Promise.all(workers.map((instance) => instance.drain()));
    expect(await leasedCount()).toBe(0);
    const states = await pool.query<{ state: string; count: string }>('SELECT state, COUNT(*)::text AS count FROM tasks GROUP BY state ORDER BY state');
    expect(states.rows).toEqual([{ state: 'QUEUED', count: '3' }, { state: 'READY', count: '2' }]);
  });

  it('parks a stage on graceful shutdown and lets another worker resume from its checkpoint', async () => {
    const [taskId] = await createQueued(1);
    const started = deferred();
    let resumedFromCheckpoint = false;
    const handlers: StageHandlers = {
      ANALYZING: {
        run: async ({ signal, checkpoint, getCheckpoint }) => {
          if (await getCheckpoint('analysis')) {
            resumedFromCheckpoint = true;
            return { kind: 'advance', to: 'READY' };
          }
          started.resolve();
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          await checkpoint('analysis', { partial: true });
          return { kind: 'interrupted' };
        },
      },
    };

    const first = worker('worker-shutdown', handlers);
    await first.runOnce();
    await started.promise;
    expect(await first.stop()).toEqual({ abandonedTaskIds: [] });
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'ANALYZING', leaseOwner: null, requiresManualIntervention: false });

    const second = worker('worker-restarted', handlers);
    await second.runOnce();
    await second.drain();
    expect(resumedFromCheckpoint).toBe(true);
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'READY', leaseOwner: null });
    expect(await transitions(taskId!)).toEqual(['QUEUED->ANALYZING', 'ANALYZING->READY']);
  });

  it('blocks a forcibly terminated worker task for manual recovery and ignores the stale worker afterwards', async () => {
    const [taskId] = await createQueued(1);
    const hung = deferred();
    const crashed = worker('worker-crashed', {
      ANALYZING: { run: async () => { await hung.promise; return { kind: 'advance', to: 'READY' }; } },
    }, { timing: { leaseDurationMs: 1_000, heartbeatIntervalMs: 600_000 } });
    await crashed.runOnce();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'ANALYZING', leaseOwner: 'worker-crashed' });

    // The crashed process never heartbeats again; a surviving worker observes the expired lease.
    const survivor = worker('worker-survivor', {
      ANALYZING: { run: async () => ({ kind: 'advance', to: 'READY' }) },
    }, { clock: () => new Date(insideHours.getTime() + 5_000) });
    await survivor.runOnce();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: true });

    // A late result from the stale worker must not advance the recovered task.
    hung.resolve();
    await crashed.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'BLOCKED', leaseOwner: null });

    await operator.retryTask(taskId!, operatorContext);
    await survivor.runOnce();
    await survivor.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'READY', requiresManualIntervention: false, lastError: null });
    expect(await transitions(taskId!)).toEqual(['QUEUED->ANALYZING', 'ANALYZING->BLOCKED', 'BLOCKED->QUEUED', 'QUEUED->ANALYZING', 'ANALYZING->READY']);
    const actions = await pool.query<{ action: string; actor: string }>('SELECT action, actor FROM operator_actions WHERE task_id = $1', [taskId]);
    expect(actions.rows).toEqual([{ action: 'RETRY_TASK', actor: operatorContext.actor }]);
  });

  it('recovers leases held by a restarted worker with a stable identity without waiting for expiry', async () => {
    const [taskId] = await createQueued(1);
    const hung = deferred();
    const previous = worker('systemd-worker', { ANALYZING: { run: async () => { await hung.promise; return { kind: 'interrupted' }; } } });
    await previous.runOnce();

    const restarted = worker('systemd-worker', {}, { recoverOwnLeasesOnStart: true });
    await restarted.start();
    await restarted.stop();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: true });

    hung.resolve();
    await previous.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'BLOCKED' });
  });

  it('pauses at a stage boundary when the schedule closes and resumes the persisted resumeState', async () => {
    const [taskId] = await createQueued(1);
    let now = insideHours;
    const handlers: StageHandlers = {
      ANALYZING: { run: async () => { now = outsideHours; return { kind: 'advance', to: 'READY' }; } },
      READY: { run: async () => ({ kind: 'advance', to: 'IMPLEMENTING' }) },
      IMPLEMENTING: { run: async () => ({ kind: 'advance', to: 'TESTING' }) },
    };
    const instance = worker('worker-schedule', handlers, { clock: () => now });

    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'PAUSED_SCHEDULE', resumeState: 'READY', pauseReason: 'OPERATING_HOURS_ENDED', leaseOwner: null });

    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'PAUSED_SCHEDULE' });

    now = insideHours;
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'TESTING', resumeState: null, leaseOwner: null });
    expect(await transitions(taskId!)).toEqual([
      'QUEUED->ANALYZING', 'ANALYZING->READY', 'READY->PAUSED_SCHEDULE', 'PAUSED_SCHEDULE->READY', 'READY->IMPLEMENTING', 'IMPLEMENTING->TESTING',
    ]);
  });

  it('continues permitted mechanical stages outside operating hours', async () => {
    const [taskId] = await createQueued(1);
    await pool.query("UPDATE tasks SET state = 'WAITING_CI' WHERE id = $1", [taskId]);
    const instance = worker('worker-mechanical', { WAITING_CI: { run: async () => ({ kind: 'advance', to: 'READY_FOR_HUMAN_REVIEW' }) } }, { clock: () => outsideHours });
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', leaseOwner: null });
  });

  it('resumes a usage-limit pause only after resumeAfter', async () => {
    const [taskId] = await createQueued(1);
    let now = insideHours;
    let limited = false;
    const handlers: StageHandlers = {
      ANALYZING: {
        run: async () => {
          if (limited) return { kind: 'advance', to: 'READY' };
          limited = true;
          return { kind: 'pause-limit', pauseReason: 'CODEX_USAGE_LIMIT', resumeAfter: new Date(now.getTime() + 10 * 60_000) };
        },
      },
    };
    const instance = worker('worker-limit', handlers, { clock: () => now });

    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'PAUSED_LIMIT', resumeState: 'ANALYZING', pauseReason: 'CODEX_USAGE_LIMIT' });

    now = new Date(insideHours.getTime() + 5 * 60_000);
    await instance.runOnce();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'PAUSED_LIMIT' });

    now = new Date(insideHours.getTime() + 11 * 60_000);
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'READY', resumeAfter: null });
  });

  it('applies an operator cancellation to a running stage through the heartbeat', async () => {
    const [taskId] = await createQueued(1);
    const started = deferred();
    const instance = worker('worker-cancel', {
      ANALYZING: {
        run: async ({ signal }) => {
          started.resolve();
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          return { kind: 'interrupted' };
        },
      },
    }, { timing: { heartbeatIntervalMs: 20 } });

    await instance.runOnce();
    await started.promise;
    expect(await operator.cancelTask(taskId!, operatorContext)).toMatchObject({ pending: true });
    await instance.drain();
    expect(await tasks.getTask(taskId!)).toMatchObject({ state: 'CANCELLED', leaseOwner: null });
    const actions = await pool.query<{ action: string }>('SELECT action FROM operator_actions WHERE task_id = $1', [taskId]);
    expect(actions.rows).toEqual([{ action: 'REQUEST_CANCEL_TASK' }]);
  });

  it('cancels, flags, and retries unleased tasks with atomic audit records', async () => {
    const [cancelId, manualId] = await createQueued(2);
    expect(await operator.cancelTask(cancelId!, operatorContext)).toMatchObject({ pending: false, task: { state: 'CANCELLED' } });
    await expect(operator.cancelTask(cancelId!, operatorContext)).rejects.toThrow('cannot be cancelled');
    await expect(operator.retryTask(cancelId!, operatorContext)).rejects.toThrow('cannot be retried');

    expect(await operator.requireManualIntervention(manualId!, operatorContext)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true });
    const instance = worker('worker-manual', { ANALYZING: { run: async () => ({ kind: 'advance', to: 'READY' }) } });
    await instance.runOnce();
    expect(await leasedCount()).toBe(0);

    const actions = await pool.query<{ action: string }>('SELECT action FROM operator_actions ORDER BY created_at');
    expect(actions.rows.map((row) => row.action)).toEqual(['CANCEL_TASK', 'REQUIRE_MANUAL_INTERVENTION']);
    const summary = await operator.queueSummary();
    expect(summary).toMatchObject({ byState: { CANCELLED: 1, BLOCKED: 1 }, leased: 0, manualIntervention: 1 });
  });

  it('stops claiming while new work is paused and parks in-flight work at the next boundary', async () => {
    const [firstId, secondId] = await createQueued(2);
    const gate = deferred();
    const instance = worker('worker-paused', {
      ANALYZING: { run: async () => { await gate.promise; return { kind: 'advance', to: 'READY' }; } },
      READY: { run: async () => ({ kind: 'advance', to: 'IMPLEMENTING' }) },
    });

    await instance.runOnce();
    await operator.setPauseNewWork(true, operatorContext);
    gate.resolve();
    await instance.drain();
    const states = [await tasks.getTask(firstId!), await tasks.getTask(secondId!)].map((task) => task?.state).sort();
    expect(states).toEqual(['QUEUED', 'READY']);
    await instance.runOnce();
    expect(await leasedCount()).toBe(0);

    await operator.setPauseNewWork(false, operatorContext);
    const controls = await operator.getControls();
    expect(controls).toMatchObject({ pauseNewWork: false, updatedBy: operatorContext.actor });
    const actions = await pool.query<{ action: string }>('SELECT action FROM operator_actions WHERE task_id IS NULL ORDER BY created_at');
    expect(actions.rows.map((row) => row.action)).toEqual(['PAUSE_NEW_WORK', 'RESUME_NEW_WORK']);
  });

  it('blocks a failed stage for manual intervention with a bounded error', async () => {
    const [taskId] = await createQueued(1);
    const log = vi.fn();
    const instance = worker('worker-failure', { ANALYZING: { run: async () => { throw new Error('x'.repeat(5_000)); } } }, { log });
    await instance.runOnce();
    await instance.drain();
    const task = await tasks.getTask(taskId!);
    expect(task).toMatchObject({ state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: true });
    expect(task?.lastError?.length).toBeLessThanOrEqual(1_001);
    expect(log).toHaveBeenCalledWith('task_stage_failed', expect.objectContaining({ taskId, stage: 'ANALYZING' }));
  });

  it('reports PostgreSQL readiness through the repository ping', async () => {
    await expect(tasks.ping()).resolves.toBeUndefined();
    const unreachable = new pg.Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    await expect(new TaskRepository(drizzle(unreachable, { schema })).ping()).rejects.toThrow();
    await unreachable.end();
  });
});
