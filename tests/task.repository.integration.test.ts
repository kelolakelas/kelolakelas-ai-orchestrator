import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { resetDatabase } from './support/database.js';

const integrationDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = integrationDatabaseUrl === undefined ? describe.skip : describe;

describeIntegration('task repository', () => {
  it('counts delivery and execution leases separately and honors a waiting task resume time', async () => {
    const pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    const repository = new TaskRepository(drizzle(pool, { schema }));
    try {
      await resetDatabase(pool);
      const create = (id: string) => repository.createTask({ linearIssueId: id, linearIdentifier: id, contractSnapshot: { id }, complexity: 'low', workUnits: [{ repository: 'web' }] });
      const reviewing = await create('KEL-201');
      const waiting = await create('KEL-202');
      await create('KEL-203');
      const now = new Date('2026-09-16T03:00:00.000Z');
      const later = new Date(now.getTime() + 60_000);
      await pool.query("UPDATE tasks SET state = 'WAITING_CI', lease_owner = 'worker-delivery', lease_expires_at = $2 WHERE id = $1", [reviewing.id, later]);
      await pool.query("UPDATE tasks SET state = 'READY_FOR_HUMAN_REVIEW', resume_after = $2 WHERE id = $1", [waiting.id, later]);
      const work = { queued: true, parkedStates: ['WAITING_CI', 'READY_FOR_HUMAN_REVIEW'] as const, scheduleResumeStates: [], limitResumeStates: [] };
      const claim = (lane: 'delivery' | 'execution', at: Date, maxConcurrentTasks = 1) => repository.claimNextTask({ leaseOwner: `worker-${lane}`, leaseDurationMs: 60_000, now: at, work: { ...work, parkedStates: [...work.parkedStates] }, maxConcurrentTasks, lane });

      // A leased delivery task does not use the execution slot, and the execution lane never claims delivery states.
      expect(await claim('execution', now)).toMatchObject({ linearIdentifier: 'KEL-203', state: 'ANALYZING' });
      expect(await claim('delivery', now)).toBeUndefined();
      // The waiting task is not claimable before its resume time, even with a free delivery slot.
      expect(await claim('delivery', now, 2)).toBeUndefined();
      expect(await claim('delivery', later, 2)).toMatchObject({ id: waiting.id, state: 'READY_FOR_HUMAN_REVIEW', leaseOwner: 'worker-delivery' });

      const deferred = await repository.deferTask(waiting.id, 'worker-delivery', new Date(later.getTime() + 60_000), 'GitHub 502');
      expect(deferred).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', leaseOwner: null, lastError: 'GitHub 502' });
      await expect(repository.deferTask(waiting.id, 'worker-delivery', later)).rejects.toThrow('leased by another worker');
      const history = await pool.query('SELECT 1 FROM state_transitions WHERE task_id = $1', [waiting.id]);
      expect(history.rowCount).toBe(0);
    } finally {
      await resetDatabase(pool);
      await pool.end();
    }
  });

  it('claims only ready tasks, records transitions, and blocks stale leases for manual recovery', async () => {
    const pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    const database = drizzle(pool, { schema });
    const repository = new TaskRepository(database);

    try {
      await resetDatabase(pool);
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
      await resetDatabase(pool);
      await pool.end();
    }
  });
});