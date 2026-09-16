import { count, desc, eq, sql } from 'drizzle-orm';
import { operatorActions, orchestratorControls, tasks } from '../db/schema.js';
import { canTransition } from '../orchestrator/state-machine.js';
import type { ScheduleOverride, TaskState } from '../types/domain.js';
import { transitionLockedTask, type Database, type DatabaseTransaction, type PersistedTask } from './task.repository.js';

const controlsId = 'global';

export interface OrchestratorControls {
  pauseNewWork: boolean;
  scheduleOverride: ScheduleOverride;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface OperatorContext {
  actor: string;
  reason: string;
}

export type OperatorActionType =
  | 'PAUSE_NEW_WORK'
  | 'RESUME_NEW_WORK'
  | 'SET_SCHEDULE_OVERRIDE'
  | 'RETRY_TASK'
  | 'CANCEL_TASK'
  | 'REQUEST_CANCEL_TASK'
  | 'REQUIRE_MANUAL_INTERVENTION';

/** Rejected operator request; the message is safe to return to the operator. */
export class OperatorActionError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'CONFLICT') {
    super(message);
    this.name = 'OperatorActionError';
  }
}

/** Operator-visible task fields. Contract snapshots and payloads are deliberately excluded. */
export interface TaskStatusView {
  id: string;
  linearIdentifier: string;
  state: TaskState;
  resumeState: TaskState | null;
  pauseReason: string | null;
  resumeAfter: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  requiresManualIntervention: boolean;
  cancelRequestedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}

const taskStatusColumns = {
  id: tasks.id,
  linearIdentifier: tasks.linearIdentifier,
  state: tasks.state,
  resumeState: tasks.resumeState,
  pauseReason: tasks.pauseReason,
  resumeAfter: tasks.resumeAfter,
  leaseOwner: tasks.leaseOwner,
  leaseExpiresAt: tasks.leaseExpiresAt,
  lastHeartbeatAt: tasks.lastHeartbeatAt,
  requiresManualIntervention: tasks.requiresManualIntervention,
  cancelRequestedAt: tasks.cancelRequestedAt,
  lastError: tasks.lastError,
  updatedAt: tasks.updatedAt,
};

export class OperatorRepository {
  constructor(private readonly db: Database) {}

  async getControls(): Promise<OrchestratorControls> {
    const selected = await this.db.select().from(orchestratorControls).where(eq(orchestratorControls.id, controlsId)).limit(1);
    const row = selected[0];
    if (!row) return { pauseNewWork: false, scheduleOverride: 'normal', updatedBy: null, updatedAt: new Date(0) };
    return { pauseNewWork: row.pauseNewWork, scheduleOverride: row.scheduleOverride, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  }

  async setPauseNewWork(paused: boolean, context: OperatorContext): Promise<OrchestratorControls> {
    return this.updateControls({ pauseNewWork: paused }, paused ? 'PAUSE_NEW_WORK' : 'RESUME_NEW_WORK', context);
  }

  async setScheduleOverride(override: ScheduleOverride, context: OperatorContext): Promise<OrchestratorControls> {
    return this.updateControls({ scheduleOverride: override }, 'SET_SCHEDULE_OVERRIDE', context, { scheduleOverride: override });
  }

  /** Re-queues a `BLOCKED` or `FAILED` task and clears manual-intervention markers. */
  async retryTask(taskId: string, context: OperatorContext): Promise<PersistedTask> {
    return this.withLockedTask(taskId, async (transaction, task) => {
      if (task.leaseOwner !== null) throw new OperatorActionError(`Task ${taskId} is leased by ${task.leaseOwner}`, 'CONFLICT');
      if (!canTransition(task.state, 'QUEUED')) throw new OperatorActionError(`Task ${taskId} cannot be retried from ${task.state}`, 'CONFLICT');
      const updated = await transitionLockedTask(transaction, task, {
        to: 'QUEUED',
        reason: `Operator retry by ${context.actor}: ${context.reason}`,
        requiresManualIntervention: false,
        lastError: null,
        clearCancelRequest: true,
      });
      await this.audit(transaction, 'RETRY_TASK', context, task.id, { from: task.state });
      return updated;
    });
  }

  /**
   * Cancels an unleased task immediately. A leased task receives a cancellation request that its owner applies at the
   * next heartbeat or stage boundary, so an in-flight side effect is never interrupted by another process.
   */
  async cancelTask(taskId: string, context: OperatorContext): Promise<{ task: PersistedTask; pending: boolean }> {
    return this.withLockedTask(taskId, async (transaction, task) => {
      if (!canTransition(task.state, 'CANCELLED')) throw new OperatorActionError(`Task ${taskId} cannot be cancelled from ${task.state}`, 'CONFLICT');
      if (task.leaseOwner !== null) {
        const updated = await transaction.update(tasks)
          .set({ cancelRequestedAt: task.cancelRequestedAt ?? new Date(), updatedAt: new Date() })
          .where(eq(tasks.id, task.id))
          .returning();
        await this.audit(transaction, 'REQUEST_CANCEL_TASK', context, task.id, { state: task.state, leaseOwner: task.leaseOwner });
        if (!updated[0]) throw new OperatorActionError(`Task not found: ${taskId}`, 'NOT_FOUND');
        return { task: updated[0], pending: true };
      }
      const updated = await transitionLockedTask(transaction, task, {
        to: 'CANCELLED',
        reason: `Operator cancellation by ${context.actor}: ${context.reason}`,
      });
      await this.audit(transaction, 'CANCEL_TASK', context, task.id, { from: task.state });
      return { task: updated, pending: false };
    });
  }

  /**
   * Stops automatic processing of a task. Unleased tasks enter `BLOCKED` when the state machine permits it; a leased
   * task is handed back by its owner at the next heartbeat or stage boundary.
   */
  async requireManualIntervention(taskId: string, context: OperatorContext): Promise<PersistedTask> {
    return this.withLockedTask(taskId, async (transaction, task) => {
      if (task.state === 'COMPLETED' || task.state === 'CANCELLED') {
        throw new OperatorActionError(`Task ${taskId} is already ${task.state}`, 'CONFLICT');
      }
      const note = `Manual intervention requested by ${context.actor}: ${context.reason}`;
      let updated: PersistedTask;
      if (task.leaseOwner === null && canTransition(task.state, 'BLOCKED')) {
        updated = await transitionLockedTask(transaction, task, { to: 'BLOCKED', reason: note, requiresManualIntervention: true, lastError: note });
      } else {
        const rows = await transaction.update(tasks)
          .set({ requiresManualIntervention: true, lastError: note, updatedAt: new Date() })
          .where(eq(tasks.id, task.id))
          .returning();
        if (!rows[0]) throw new OperatorActionError(`Task not found: ${taskId}`, 'NOT_FOUND');
        updated = rows[0];
      }
      await this.audit(transaction, 'REQUIRE_MANUAL_INTERVENTION', context, task.id, { state: task.state, leaseOwner: task.leaseOwner });
      return updated;
    });
  }

  async queueSummary(): Promise<{ byState: Partial<Record<TaskState, number>>; leased: number; manualIntervention: number }> {
    const rows = await this.db.select({
      state: tasks.state,
      total: count(),
      leased: sql<number>`count(*) filter (where ${tasks.leaseOwner} is not null)`.mapWith(Number),
      manual: sql<number>`count(*) filter (where ${tasks.requiresManualIntervention})`.mapWith(Number),
    }).from(tasks).groupBy(tasks.state);
    const byState: Partial<Record<TaskState, number>> = {};
    let leased = 0;
    let manualIntervention = 0;
    for (const row of rows) {
      byState[row.state] = row.total;
      leased += row.leased;
      manualIntervention += row.manual;
    }
    return { byState, leased, manualIntervention };
  }

  async listTasks(limit = 100): Promise<TaskStatusView[]> {
    return this.db.select(taskStatusColumns).from(tasks).orderBy(desc(tasks.updatedAt)).limit(limit);
  }

  async getTaskStatus(taskId: string): Promise<TaskStatusView | undefined> {
    const selected = await this.db.select(taskStatusColumns).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return selected[0];
  }

  async listActions(taskId?: string, limit = 100): Promise<Array<typeof operatorActions.$inferSelect>> {
    const query = this.db.select().from(operatorActions);
    const filtered = taskId === undefined ? query : query.where(eq(operatorActions.taskId, taskId));
    return filtered.orderBy(desc(operatorActions.createdAt)).limit(limit);
  }

  private async updateControls(
    patch: Partial<Pick<OrchestratorControls, 'pauseNewWork' | 'scheduleOverride'>>,
    action: OperatorActionType,
    context: OperatorContext,
    details: Record<string, unknown> = {},
  ): Promise<OrchestratorControls> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const rows = await transaction.insert(orchestratorControls)
        .values({ id: controlsId, ...patch, updatedBy: context.actor, updatedAt: now })
        .onConflictDoUpdate({ target: orchestratorControls.id, set: { ...patch, updatedBy: context.actor, updatedAt: now } })
        .returning();
      await this.audit(transaction, action, context, null, details);
      const row = rows[0];
      if (!row) throw new Error('Failed to update orchestrator controls');
      return { pauseNewWork: row.pauseNewWork, scheduleOverride: row.scheduleOverride, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
    });
  }

  private async withLockedTask<T>(taskId: string, operation: (transaction: DatabaseTransaction, task: PersistedTask) => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction) => {
      const selected = await transaction.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).for('update');
      const task = selected[0];
      if (!task) throw new OperatorActionError(`Task not found: ${taskId}`, 'NOT_FOUND');
      return operation(transaction, task);
    });
  }

  private async audit(
    transaction: DatabaseTransaction,
    action: OperatorActionType,
    context: OperatorContext,
    taskId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await transaction.insert(operatorActions).values({ action, actor: context.actor, reason: context.reason, taskId, details });
  }
}
