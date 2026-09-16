import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeMigration = migrationDatabaseUrl === undefined ? describe.skip : describe;

async function applyMigration(client: Client, name: string): Promise<void> {
  const contents = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  for (const statement of contents.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') await client.query(statement);
  }
}

async function resetDatabase(client: Client): Promise<void> {
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
}

// Schema resets and DDL fsync heavily; allow for slow disks rather than the 5 second default.
describeMigration('database migrations', { timeout: 60_000 }, () => {
  it('preserves Phase 1 tasks, Phase 4 attempts, and work units through every migration', async () => {
    const client = new Client({ connectionString: migrationDatabaseUrl });
    await client.connect();

    try {
      await resetDatabase(client);
      await applyMigration(client, '0000_fancy_harrier.sql');
      await client.query("INSERT INTO tasks (linear_issue_id, linear_identifier, complexity) VALUES ('issue-1', 'KEL-1', 'medium')");
      await applyMigration(client, '0001_add_task_complexity_enum.sql');

      const task = await client.query<{ complexity: string }>('SELECT complexity FROM tasks WHERE linear_issue_id = $1', ['issue-1']);
      const column = await client.query<{ udt_name: string }>("SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'complexity'");

      expect(task.rows).toEqual([{ complexity: 'medium' }]);
      expect(column.rows).toEqual([{ udt_name: 'task_complexity' }]);
      await applyMigration(client, '0002_blue_tyrannus.sql');
      const workUnits = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task_work_units'");
      expect(workUnits.rows).toEqual([{ table_name: 'task_work_units' }]);

      await applyMigration(client, '0003_true_grey_gargoyle.sql');
      await applyMigration(client, '0004_phase3_scheduler_controls.sql');
      await applyMigration(client, '0005_phase4_workspace_identity.sql');
      const phase4 = await client.query<{ id: string }>('SELECT id FROM tasks WHERE linear_issue_id = $1', ['issue-1']);
      await client.query("INSERT INTO task_attempts (task_id, stage, attempt, result) VALUES ($1, 'ANALYZING', 1, '{\"legacy\": true}')", [phase4.rows[0]?.id]);
      await applyMigration(client, '0006_phase5_agent_attempts.sql');
      await client.query("INSERT INTO task_work_units (task_id, repository, branch) VALUES ($1, 'web', 'kel-1-legacy')", [phase4.rows[0]?.id]);
      await applyMigration(client, '0007_phase6_delivery.sql');
      const unit = await client.query('SELECT branch, pushed_commit, pull_request_number, merge_commit, delivery_observation FROM task_work_units');
      expect(unit.rows).toEqual([{ branch: 'kel-1-legacy', pushed_commit: null, pull_request_number: null, merge_commit: null, delivery_observation: null }]);
      const attempt = await client.query<{ result: unknown; input: unknown; evidence: unknown; usage: unknown }>('SELECT result, input, evidence, usage FROM task_attempts');
      expect(attempt.rows).toEqual([{ result: { legacy: true }, input: null, evidence: null, usage: null }]);
      const upgraded = await client.query<{ complexity: string; resume_after: Date | null; cancel_requested_at: Date | null }>(
        'SELECT complexity, resume_after, cancel_requested_at FROM tasks WHERE linear_issue_id = $1',
        ['issue-1'],
      );
      expect(upgraded.rows).toEqual([{ complexity: 'medium', resume_after: null, cancel_requested_at: null }]);
      const controls = await client.query<{ id: string; pause_new_work: boolean; schedule_override: string }>(
        'SELECT id, pause_new_work, schedule_override FROM orchestrator_controls',
      );
      expect(controls.rows).toEqual([{ id: 'global', pause_new_work: false, schedule_override: 'normal' }]);
      const states = await client.query<{ states: string }>("SELECT enum_range(NULL::task_state)::text AS states");
      expect(states.rows[0]?.states).toContain('CANCELLED');
      const workspaceIndexes = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'task_work_units' AND indexname LIKE 'task_work_units_%_unique' ORDER BY indexname",
      );
      expect(workspaceIndexes.rows.map((row) => row.indexname)).toEqual([
        'task_work_units_repository_branch_unique', 'task_work_units_repository_pull_request_unique', 'task_work_units_task_repository_unique',
        'task_work_units_workspace_path_unique',
      ]);
    } finally {
      await resetDatabase(client);
      await client.end();
    }
  });
});