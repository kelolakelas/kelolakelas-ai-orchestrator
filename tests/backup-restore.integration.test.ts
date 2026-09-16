import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { backupDatabase, restoreDatabase } from '../src/ops/database-backup.js';
import { Scheduler } from '../src/orchestrator/scheduler.js';
import { OperatorRepository } from '../src/repositories/operator.repository.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { testConfig } from './support/config.js';

const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const toolsAvailable = ['pg_dump', 'pg_restore', 'psql'].every((tool) => spawnSync(tool, ['--version']).status === 0);
if (adminUrl !== undefined && !toolsAvailable && process.env.CI === 'true') throw new Error('PostgreSQL client tools are required for the recovery drill in CI');
const describeDrill = adminUrl !== undefined && toolsAvailable ? describe : describe.skip;

function databaseUrl(name: string): string {
  const url = new URL(adminUrl ?? 'postgres://localhost/postgres');
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Recovery drill: back up a database with in-flight work, restore it into a new database, and prove that the restored
 * orchestrator recovers stale leases for manual intervention and continues after an operator retry.
 */
describeDrill('backup, restore, and stale-task recovery drill', { timeout: 120_000 }, () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceName = `drill_source_${suffix}`;
  const restoreName = `drill_restore_${suffix}`;
  let admin: pg.Client;
  let directory: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${sourceName}`);
    await admin.query(`CREATE DATABASE ${restoreName}`);
    directory = mkdtempSync(join(tmpdir(), 'orchestrator-backups-'));
  });

  afterAll(async () => {
    for (const name of [sourceName, restoreName]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  });

  it('restores every record and recovers a task that was mid-stage when the backup was taken', async () => {
    const source = new pg.Pool({ connectionString: databaseUrl(sourceName) });
    const sourceDb = drizzle(source, { schema });
    await migrate(sourceDb, { migrationsFolder: './migrations' });
    const sourceTasks = new TaskRepository(sourceDb);
    const inFlight = await sourceTasks.createTask({ linearIssueId: 'drill-1', linearIdentifier: 'KEL-701', contractSnapshot: { drill: true }, complexity: 'low', workUnits: [{ repository: 'web' }] });
    await sourceTasks.createTask({ linearIssueId: 'drill-2', linearIdentifier: 'KEL-702', contractSnapshot: {}, complexity: 'low', workUnits: [{ repository: 'billing' }] });
    const claimed = await sourceTasks.claimNextTask({
      leaseOwner: 'crashed-worker', leaseDurationMs: 60_000, now: new Date(Date.now() - 10 * 60_000), maxConcurrentTasks: 5,
      work: { queued: true, parkedStates: [], scheduleResumeStates: [], limitResumeStates: [] },
    });
    expect(claimed?.id).toBe(inFlight.id);
    await sourceTasks.recordCheckpoint(inFlight.id, 'ANALYZING', 'analysis-accepted', { plan: 'kept' });
    await new OperatorRepository(sourceDb).setPauseNewWork(false, { actor: 'drill', reason: 'seed an audit record' });
    await source.end();

    const manifest = await backupDatabase({ databaseUrl: databaseUrl(sourceName), directory, keepDays: 30 });
    expect(manifest).toMatchObject({ rowCounts: { tasks: 2, task_work_units: 2, task_checkpoints: 1, operator_actions: 1 } });
    expect(manifest.migrations).toBeGreaterThanOrEqual(9);
    const dumpPath = join(directory, manifest.file);

    // A tampered dump is refused before anything is restored.
    const tampered = join(directory, 'tampered.dump');
    writeFileSync(tampered, Buffer.concat([readFileSync(dumpPath), Buffer.from('x')]));
    writeFileSync(`${tampered}.json`, readFileSync(`${dumpPath}.json`));
    await expect(restoreDatabase({ dumpPath: tampered, targetDatabaseUrl: databaseUrl(restoreName) })).rejects.toThrow(/checksum mismatch/);

    const { restored } = await restoreDatabase({ dumpPath, targetDatabaseUrl: databaseUrl(restoreName) });
    expect(restored.rowCounts).toMatchObject(manifest.rowCounts);
    // Restoring twice into the same database is refused rather than merged.
    await expect(restoreDatabase({ dumpPath, targetDatabaseUrl: databaseUrl(restoreName) })).rejects.toThrow(/not empty/);

    const target = new pg.Pool({ connectionString: databaseUrl(restoreName) });
    try {
      const targetDb = drizzle(target, { schema });
      // The restored schema is current: re-running migrations is a no-op.
      await migrate(targetDb, { migrationsFolder: './migrations' });
      const tasks = new TaskRepository(targetDb);
      const operator = new OperatorRepository(targetDb);
      expect(await tasks.getTask(inFlight.id)).toMatchObject({ state: 'ANALYZING', leaseOwner: 'crashed-worker' });

      const ran: string[] = [];
      const scheduler = new Scheduler({
        config: testConfig({ schedule: { enabled: false }, orchestrator: { maxConcurrentTasks: 2 } }),
        linear: { listIssues: async () => [] },
        tasks,
        operator,
        workerId: 'restored-worker',
        dryRun: false,
        log: () => undefined,
        handlers: { ANALYZING: { run: async ({ task }) => { ran.push(task.linearIdentifier); return { kind: 'advance', to: 'READY' }; } } },
        // The lease was taken ten minutes before the backup, so it has expired by now. The schedule is disabled.
        clock: () => new Date(),
      });
      await scheduler.runOnce();
      await scheduler.drain();

      // The stale lease is never resumed automatically: its side effects are unknown.
      expect(await tasks.getTask(inFlight.id)).toMatchObject({ state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: true });
      expect(ran).toEqual(['KEL-702']);
      expect(await tasks.getCheckpoint(inFlight.id, 'analysis-accepted')).toEqual({ plan: 'kept' });

      await operator.retryTask(inFlight.id, { actor: 'drill', reason: 'verified after restore' });
      await scheduler.runOnce();
      await scheduler.drain();
      expect(await tasks.getTask(inFlight.id)).toMatchObject({ state: 'READY' });
      expect(ran).toEqual(['KEL-702', 'KEL-701']);
    } finally {
      await target.end();
    }
  });
});
