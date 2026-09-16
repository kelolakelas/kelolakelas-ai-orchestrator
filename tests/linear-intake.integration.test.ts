import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { persistLinearIntake, type IntakeReport } from '../src/intake/linear-discovery.js';
import { validatePlanningIssue } from '../src/intake/planning-contract.js';
import { TaskRepository } from '../src/repositories/task.repository.js';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

function issue(draftKey: string, linearId: string, blockedByDraftKeys: string[] = []) {
  return validatePlanningIssue({
    draftKey, projectKey: null, title: draftKey, type: 'Feature', priority: 'High', estimate: 'S', complexity: 'low', labels: ['web', 'ai-ready'], repositories: ['web'], blockedByDraftKeys, externalDependencies: [],
    body: { backgroundProblem: 'Problem', goal: 'Goal', requirements: ['Requirement'], acceptanceCriteria: ['Criterion'], technicalNotes: 'Notes', relevantAreas: ['src/intake'], edgeCases: ['Edge'], testingValidation: ['Test'], outOfScope: ['None'] },
    source: { linearIssueId: linearId, linearIdentifier: `KEL-${linearId}`, linearCreatedAt: '2026-09-15T10:00:00.000Z', gitBranchName: `branch-${linearId}`, linearBlockedByIdentifiers: [] },
  });
}

describeIntegration('Linear intake persistence', () => {
  it('upserts valid issues, synchronizes dependencies, and durably quarantines invalid or changed contracts', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const repository = new TaskRepository(drizzle(pool, { schema }));
    try {
      await pool.query('TRUNCATE tasks, intake_quarantines CASCADE');
      const blocker = issue('blocker-task', '1');
      const dependent = issue('dependent-task', '2', ['blocker-task']);
      const report: IntakeReport = { eligible: [blocker, dependent], quarantined: [{ id: 'bad-1', identifier: 'KEL-BAD', reason: 'Missing contract', payload: { description: 'invalid' } }], ignored: [] };
      await persistLinearIntake(repository, report);
      await persistLinearIntake(repository, report);
      expect((await pool.query('SELECT COUNT(*)::text AS count FROM tasks')).rows).toEqual([{ count: '2' }]);
      expect((await pool.query('SELECT COUNT(*)::text AS count FROM task_dependencies')).rows).toEqual([{ count: '1' }]);
      expect((await pool.query('SELECT COUNT(*)::text AS count FROM intake_quarantines')).rows).toEqual([{ count: '1' }]);

      const changed = issue('blocker-task', '1');
      changed.title = 'Changed contract';
      await persistLinearIntake(repository, { eligible: [changed], quarantined: [], ignored: [] });
      const quarantines = await pool.query<{ linear_issue_id: string }>('SELECT linear_issue_id FROM intake_quarantines ORDER BY linear_issue_id');
      expect(quarantines.rows).toEqual([{ linear_issue_id: '1' }, { linear_issue_id: 'bad-1' }]);
    } finally {
      await pool.query('TRUNCATE tasks, intake_quarantines CASCADE');
      await pool.end();
    }
  });
});