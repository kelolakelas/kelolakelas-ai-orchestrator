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

describeMigration('database migrations', () => {
  it('preserves a Phase 1 task through every migration including Phase 3 controls', async () => {
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
    } finally {
      await resetDatabase(client);
      await client.end();
    }
  });
});