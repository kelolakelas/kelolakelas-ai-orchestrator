import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { TaskRepository } from '../src/repositories/task.repository.js';

const integrationDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = integrationDatabaseUrl === undefined ? describe.skip : describe;

describeIntegration('task repository', () => {
  it('claims only ready tasks, records transitions, and blocks stale leases for manual recovery', async () => {
    const pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    const database = drizzle(pool, { schema });
    const repository = new TaskRepository(database);

    try {
      await pool.query('TRUNCATE tasks CASCADE');
      const first = await repository.createTask({
        linearIssueId: 'issue-concurrent-1',
        linearIdentifier: 'KEL-101',
        contractSnapshot: { schemaVersion: 'kelolakelas.planning-backlog/v1' },
        complexity: 'low',
        workUnits: [{ repository: 'web' }],
      });
      const second = await repository.createTask({
        linearIssueId: 'issue-concurrent-2',
        linearIdentifier: 'KEL-102',
        contractSnapshot: { schemaVersion: 'kelolakelas.planning-backlog/v1' },
        complexity: 'low',
        workUnits: [{ repository: 'academic' }],
      });

      const concurrentClaims = await Promise.all([
        repository.claimNextQueuedTask({ leaseOwner: 'worker-a', leaseDurationMs: 60_000 }),
        repository.claimNextQueuedTask({ leaseOwner: 'worker-b', leaseDurationMs: 60_000 }),
      ]);
      expect(new Set(concurrentClaims.map((task) => task?.id)).size).toBe(2);
      expect(new Set(concurrentClaims.map((task) => task?.id))).toEqual(new Set([first.id, second.id]));

      const blocker = await repository.createTask({
        linearIssueId: 'issue-blocker',
        linearIdentifier: 'KEL-103',
        contractSnapshot: { schemaVersion: 'kelolakelas.planning-backlog/v1' },
        complexity: 'medium',
        workUnits: [{ repository: 'identity' }],
      });
      const dependent = await repository.createTask({
        linearIssueId: 'issue-dependent',
        linearIdentifier: 'KEL-104',
        contractSnapshot: { schemaVersion: 'kelolakelas.planning-backlog/v1' },
        complexity: 'medium',
        blockerTaskIds: [blocker.id],
        workUnits: [{ repository: 'web' }, { repository: 'academic', outcome: 'Preserve enrollment contract' }],
      });

      const claimedBlocker = await repository.claimNextQueuedTask({ leaseOwner: 'worker-c', leaseDurationMs: 60_000 });
      expect(claimedBlocker?.id).toBe(blocker.id);
      expect(await repository.claimNextQueuedTask({ leaseOwner: 'worker-d', leaseDurationMs: 60_000 })).toBeUndefined();

      for (const state of ['READY', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW', 'COMPLETED'] as const) {
        await repository.transitionTask({ taskId: blocker.id, to: state, leaseOwner: 'worker-c' });
      }

      const now = new Date('2026-09-15T10:00:00.000Z');
      const claimedDependent = await repository.claimNextQueuedTask({ leaseOwner: 'worker-d', leaseDurationMs: 1_000, now });
      expect(claimedDependent?.id).toBe(dependent.id);
      expect(claimedDependent?.leaseOwner).toBe('worker-d');
      await expect(repository.transitionTask({ taskId: dependent.id, to: 'READY', leaseOwner: 'worker-e' })).rejects.toThrow('leased by another worker');

      await repository.recordCheckpoint(dependent.id, 'ANALYZING', 'analysis-complete', { version: 1 });
      await repository.recordCheckpoint(dependent.id, 'ANALYZING', 'analysis-complete', { version: 2 });
      const checkpointCount = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM task_checkpoints WHERE task_id = $1', [dependent.id]);
      const checkpoint = await pool.query<{ payload: { version: number } }>('SELECT payload FROM task_checkpoints WHERE task_id = $1', [dependent.id]);
      expect(checkpointCount.rows).toEqual([{ count: '1' }]);
      expect(checkpoint.rows).toEqual([{ payload: { version: 2 } }]);
      await repository.recordAttempt({
        taskId: dependent.id,
        stage: 'ANALYZING',
        attempt: 1,
        result: { summary: 'Contract parsed' },
        completedAt: now,
      });
      const firstOperation = await repository.recordExternalOperation({
        taskId: dependent.id,
        operationType: 'LINEAR_COMMENT',
        idempotencyKey: `${dependent.id}:linear-comment`,
        request: { body: 'Task started' },
      });
      const repeatedOperation = await repository.recordExternalOperation({
        taskId: dependent.id,
        operationType: 'LINEAR_COMMENT',
        idempotencyKey: `${dependent.id}:linear-comment`,
        request: { body: 'Task started' },
      });
      expect(repeatedOperation.id).toBe(firstOperation.id);
      const attempts = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM task_attempts WHERE task_id = $1', [dependent.id]);
      const operations = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM external_operations WHERE task_id = $1', [dependent.id]);
      expect(attempts.rows).toEqual([{ count: '1' }]);
      expect(operations.rows).toEqual([{ count: '1' }]);

      const recovered = await repository.recoverExpiredLeases(new Date(now.getTime() + 1_001));
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ id: dependent.id, state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: true });

      const transitions = await pool.query<{ from_state: string | null; to_state: string }>('SELECT from_state, to_state FROM state_transitions WHERE task_id = $1', [dependent.id]);
      expect(transitions.rows).toHaveLength(2);
      expect(transitions.rows).toContainEqual({ from_state: 'QUEUED', to_state: 'ANALYZING' });
      expect(transitions.rows).toContainEqual({ from_state: 'ANALYZING', to_state: 'BLOCKED' });
      const workUnits = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM task_work_units WHERE task_id = $1', [dependent.id]);
      expect(workUnits.rows).toEqual([{ count: '2' }]);
    } finally {
      await pool.query('TRUNCATE tasks CASCADE');
      await pool.end();
    }
  });
});