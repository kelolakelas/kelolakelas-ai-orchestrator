import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { validateConfig } from '../config/schema.js';
import * as schema from '../db/schema.js';
import { Scheduler } from '../orchestrator/scheduler.js';
import type { SchedulerObserver } from '../observability/orchestrator-metrics.js';
import { MetricsRepository } from '../repositories/metrics.repository.js';
import { OperatorRepository } from '../repositories/operator.repository.js';
import { TaskRepository } from '../repositories/task.repository.js';

/**
 * Scheduler load test against a disposable PostgreSQL database. Several worker processes (each with its own pool)
 * claim from a large queue while a sampler checks that execution, delivery, and per-repository lease limits hold at every
 * instant. Reports claim throughput, tick latency, and metrics-scrape latency.
 *
 * Usage: LOAD_TEST_DATABASE_URL=postgres://.../orchestrator_load npx tsx src/ops/load-test.ts
 * Optional: LOAD_TASKS, LOAD_DELIVERY_TASKS, LOAD_WORKERS, LOAD_POOL_SIZE, LOAD_MAX_CONCURRENT, LOAD_REPOSITORY_LIMIT,
 * LOAD_STAGE_MS, LOAD_DURATION_SECONDS, LOAD_POLL_INTERVAL_MS. The database name must contain "load"; every orchestrator table in it is emptied.
 */
const url = process.env.LOAD_TEST_DATABASE_URL;
if (url === undefined || !/load/i.test(new URL(url).pathname)) {
  console.error('LOAD_TEST_DATABASE_URL must name a disposable database whose name contains "load"');
  process.exit(2);
}
const numberFrom = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const settings = {
  tasks: numberFrom('LOAD_TASKS', 5_000),
  deliveryTasks: numberFrom('LOAD_DELIVERY_TASKS', 500),
  workers: numberFrom('LOAD_WORKERS', 4),
  poolSize: numberFrom('LOAD_POOL_SIZE', 10),
  maxConcurrentTasks: numberFrom('LOAD_MAX_CONCURRENT', 8),
  maxConcurrentDeliveryTasks: numberFrom('LOAD_MAX_DELIVERY', 16),
  repositoryLimit: numberFrom('LOAD_REPOSITORY_LIMIT', 3),
  stageMs: numberFrom('LOAD_STAGE_MS', 50),
  durationSeconds: numberFrom('LOAD_DURATION_SECONDS', 60),
  pollIntervalMs: numberFrom('LOAD_POLL_INTERVAL_MS', 2_000),
};
const repositories = ['web', 'api-gateway', 'academic', 'identity', 'billing'] as const;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]! * 10) / 10;
}

const admin = new pg.Pool({ connectionString: url, max: 4 });
await migrate(drizzle(admin), { migrationsFolder: './migrations' });
await admin.query(`DELETE FROM operator_actions; DELETE FROM state_transitions; DELETE FROM task_checkpoints; DELETE FROM task_attempts;
  DELETE FROM external_operations; DELETE FROM task_dependencies; DELETE FROM task_work_units; DELETE FROM tasks; DELETE FROM intake_quarantines;
  UPDATE orchestrator_controls SET pause_new_work = false, kill_switch = false, schedule_override = 'normal';`);

const seedStarted = Date.now();
await admin.query(`
  INSERT INTO tasks (linear_issue_id, linear_identifier, state, complexity, created_at)
  SELECT 'load-' || i, 'LOAD-' || i, CASE WHEN i <= $2 THEN 'WAITING_CI'::task_state ELSE 'QUEUED'::task_state END, 'low', now() - (i || ' seconds')::interval
  FROM generate_series(1, $1::int + $2::int) AS i`, [settings.tasks, settings.deliveryTasks]);
await admin.query(`
  INSERT INTO task_work_units (task_id, repository)
  SELECT id, (ARRAY['web','api-gateway','academic','identity','billing'])[1 + (abs(hashtext(id::text)) % 5)] FROM tasks`);
await admin.query(`
  INSERT INTO task_work_units (task_id, repository)
  SELECT id, 'web' FROM tasks t WHERE abs(hashtext(id::text)) % 4 = 0
    AND NOT EXISTS (SELECT 1 FROM task_work_units w WHERE w.task_id = t.id AND w.repository = 'web')`);
await admin.query(`INSERT INTO state_transitions (task_id, from_state, to_state) SELECT id, 'PR_CREATED', 'WAITING_CI' FROM tasks WHERE state = 'WAITING_CI'`);
await admin.query('ANALYZE');
const seedMs = Date.now() - seedStarted;

const config = validateConfig({
  timezone: 'Asia/Jakarta',
  orchestrator: { maxConcurrentTasks: settings.maxConcurrentTasks, maxConcurrentDeliveryTasks: settings.maxConcurrentDeliveryTasks },
  schedule: { enabled: false, days: {} },
  linear: { teamKey: 'KEL' },
  models: { analyzer: { tier: 'terra', effort: 'high' }, reviewer: { tier: 'terra', effort: 'high' }, tiers: { terra: { model: 'm' } } },
  limits: {},
  repositories: Object.fromEntries(repositories.map((name) => [name, { path: `/srv/${name}`, github: `kelolakelas/${name}`, maxConcurrentTasks: settings.repositoryLimit }])),
});

const tickMs: number[] = [];
let stagesCompleted = 0;
const observer: SchedulerObserver = {
  tickCompleted: (duration) => { tickMs.push(duration); },
  intakePolled: () => undefined,
  stageFinished: () => { stagesCompleted += 1; },
  stateExited: () => undefined,
  leasesRecovered: () => undefined,
  taskParked: () => undefined,
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pools: pg.Pool[] = [];
const workers = Array.from({ length: settings.workers }, (_, index) => {
  const pool = new pg.Pool({ connectionString: url, max: settings.poolSize });
  pools.push(pool);
  const db = drizzle(pool, { schema });
  return new Scheduler({
    config,
    linear: { listIssues: async () => [] },
    tasks: new TaskRepository(db),
    operator: new OperatorRepository(db),
    workerId: `load-worker-${index}`,
    dryRun: false,
    log: () => undefined,
    observer,
    timing: { heartbeatIntervalMs: 5_000, leaseDurationMs: 60_000, pollIntervalMs: settings.pollIntervalMs },
    handlers: {
      ANALYZING: { run: async () => { await sleep(settings.stageMs); return { kind: 'advance', to: 'READY' }; } },
      READY: { run: async () => { await sleep(settings.stageMs); return { kind: 'advance', to: 'BLOCKED', reason: 'load test end state' }; } },
      WAITING_CI: { run: async () => { await sleep(settings.stageMs / 5); return { kind: 'wait', until: new Date(Date.now() + 2_000), reason: 'load test poll' }; } },
    },
  });
});

const violations: string[] = [];
const peaks = { execution: 0, delivery: 0, repository: 0 };
let running = true;
const sampler = (async () => {
  while (running) {
    const lanes = await admin.query<{ execution: string; delivery: string }>(`
      SELECT count(*) FILTER (WHERE state NOT IN ('PR_CREATED','WAITING_CI','READY_FOR_HUMAN_REVIEW'))::text AS execution,
             count(*) FILTER (WHERE state IN ('PR_CREATED','WAITING_CI','READY_FOR_HUMAN_REVIEW'))::text AS delivery
      FROM tasks WHERE lease_owner IS NOT NULL`);
    const perRepository = await admin.query<{ repository: string; leased: string }>(`
      SELECT w.repository, count(DISTINCT t.id)::text AS leased FROM tasks t JOIN task_work_units w ON w.task_id = t.id
      WHERE t.lease_owner IS NOT NULL AND t.state NOT IN ('PR_CREATED','WAITING_CI','READY_FOR_HUMAN_REVIEW') GROUP BY w.repository`);
    const execution = Number(lanes.rows[0]?.execution ?? 0);
    const delivery = Number(lanes.rows[0]?.delivery ?? 0);
    const repository = Math.max(0, ...perRepository.rows.map((row) => Number(row.leased)));
    peaks.execution = Math.max(peaks.execution, execution);
    peaks.delivery = Math.max(peaks.delivery, delivery);
    peaks.repository = Math.max(peaks.repository, repository);
    if (execution > settings.maxConcurrentTasks) violations.push(`execution leases ${execution}`);
    if (delivery > settings.maxConcurrentDeliveryTasks) violations.push(`delivery leases ${delivery}`);
    if (repository > settings.repositoryLimit) violations.push(`repository leases ${repository}`);
    await sleep(25);
  }
})();

const startedAt = Date.now();
await Promise.all(workers.map(async (worker) => {
  while (Date.now() - startedAt < settings.durationSeconds * 1_000) {
    await worker.runOnce();
    await sleep(settings.pollIntervalMs);
  }
  await worker.stop();
}));
running = false;
await sampler;

const scrapeMs: number[] = [];
const metrics = new MetricsRepository(drizzle(admin, { schema }));
for (let index = 0; index < 20; index += 1) {
  const started = performance.now();
  await metrics.snapshot();
  scrapeMs.push(performance.now() - started);
}
const finished = await admin.query<{ blocked: string }>(`SELECT count(*)::text AS blocked FROM tasks WHERE state = 'BLOCKED'`);
const elapsedSeconds = (Date.now() - startedAt) / 1_000;

console.log(JSON.stringify({
  settings,
  seedMs,
  elapsedSeconds: Math.round(elapsedSeconds),
  tasksFinished: Number(finished.rows[0]?.blocked ?? 0),
  tasksFinishedPerSecond: Math.round(Number(finished.rows[0]?.blocked ?? 0) / elapsedSeconds * 10) / 10,
  stagesCompleted,
  peakLeases: peaks,
  violations: violations.slice(0, 10),
  tickMs: { p50: percentile(tickMs, 0.5), p95: percentile(tickMs, 0.95), max: percentile(tickMs, 1) },
  metricsSnapshotMs: { p50: percentile(scrapeMs, 0.5), p95: percentile(scrapeMs, 0.95) },
}, null, 2));

await Promise.all([...pools, admin].map((pool) => pool.end()));
process.exitCode = violations.length > 0 ? 1 : 0;
