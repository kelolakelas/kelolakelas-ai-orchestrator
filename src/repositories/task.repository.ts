import { and, asc, count, eq, inArray, isNotNull, isNull, lt, lte, ne, notExists, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type * as schema from '../db/schema.js';
import { externalOperations, intakeQuarantines, stateTransitions, taskAttempts, taskCheckpoints, taskDependencies, taskWorkUnits, tasks } from '../db/schema.js';
import { canTransition, transitionTask as validateTransition } from '../orchestrator/state-machine.js';
import type { ComplexityValue } from '../types/complexity.js';
import type { PauseReason, TaskState } from '../types/domain.js';

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type PersistedTask = typeof tasks.$inferSelect;

/** Serializes claims across every orchestrator process sharing the database. */
const claimLockName = 'kelolakelas.ai-orchestrator.task-claim';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class LeaseOwnershipError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} is leased by another worker`);
    this.name = 'LeaseOwnershipError';
  }
}

export class ContractChangedError extends Error {
  constructor(linearIssueId: string) {
    super(`Persisted contract changed for Linear issue: ${linearIssueId}`);
    this.name = 'ContractChangedError';
  }
}

export interface CreateTaskInput {
  linearIssueId: string;
  linearIdentifier: string;
  contractSnapshot: Record<string, unknown>;
  complexity: ComplexityValue;
  risk?: string;
  blockerTaskIds?: readonly string[];
  workUnits: readonly {
    repository: string;
    outcome?: string;
  }[];
}

export interface TaskTransitionInput {
  taskId: string;
  to: TaskState;
  reason?: string;
  resumeState?: TaskState;
  pauseReason?: PauseReason;
  resumeAfter?: Date;
  leaseOwner?: string;
  releaseLease?: boolean;
  lastError?: string | null;
  requiresManualIntervention?: boolean;
}

export interface TaskClaimInput {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: Date;
}

/**
 * Describes which persisted tasks the caller is currently able to execute.
 * The scheduler derives it from registered stage handlers, operating hours, and operator controls.
 */
export interface ClaimableWork {
  /** Claim a `QUEUED` task whose blockers are complete and start `ANALYZING`. */
  queued: boolean;
  /** Continue an unleased task parked at a stage boundary in one of these states. */
  parkedStates: readonly TaskState[];
  /** Resume `PAUSED_SCHEDULE` tasks whose `resumeState` is listed. */
  scheduleResumeStates: readonly TaskState[];
  /** Resume `PAUSED_LIMIT` tasks whose `resumeState` is listed and whose `resumeAfter` has passed. */
  limitResumeStates: readonly TaskState[];
}

export interface TaskClaimWithLimitInput extends TaskClaimInput {
  work: ClaimableWork;
  maxConcurrentTasks: number;
}

export interface LockedTransitionInput {
  to: TaskState;
  reason?: string;
  resumeState?: TaskState;
  pauseReason?: PauseReason;
  resumeAfter?: Date;
  leaseOwner?: string;
  allowExpiredLease?: boolean;
  requiresManualIntervention?: boolean;
  lastError?: string | null;
  clearCancelRequest?: boolean;
  lease?: { owner: string | null; expiresAt: Date | null; heartbeatAt: Date | null };
}

const clearedLease = { owner: null, expiresAt: null, heartbeatAt: null } as const;

/**
 * Validates and applies one transition to a row already locked by `transaction`, then appends its history record.
 * Shared by every repository that changes task state so state and history cannot diverge.
 */
export async function transitionLockedTask(
  transaction: DatabaseTransaction,
  task: PersistedTask,
  input: LockedTransitionInput,
): Promise<PersistedTask> {
  if (task.leaseOwner !== null && input.leaseOwner !== task.leaseOwner && !input.allowExpiredLease) {
    throw new LeaseOwnershipError(task.id);
  }
  // A caller acting as a lease owner must still hold the lease; it may have been recovered or released meanwhile.
  if (input.leaseOwner !== undefined && task.leaseOwner !== input.leaseOwner && input.lease === undefined) {
    throw new LeaseOwnershipError(task.id);
  }

  const transition = validateTransition(task.state, input.to, {
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.resumeState === undefined ? {} : { resumeState: input.resumeState }),
    ...(input.pauseReason === undefined ? {} : { pauseReason: input.pauseReason }),
  });
  const now = new Date();
  const paused = transition.to === 'PAUSED_SCHEDULE' || transition.to === 'PAUSED_LIMIT';
  const updates: Partial<typeof tasks.$inferInsert> = {
    state: transition.to,
    resumeState: transition.resumeState ?? null,
    pauseReason: transition.pauseReason ?? null,
    pausedAt: paused ? now : null,
    resumeAfter: paused ? input.resumeAfter ?? null : null,
    requiresManualIntervention: input.requiresManualIntervention ?? task.requiresManualIntervention,
    updatedAt: now,
  };
  if (input.lastError !== undefined) updates.lastError = input.lastError;
  if (input.clearCancelRequest) updates.cancelRequestedAt = null;
  if (input.lease !== undefined) {
    updates.leaseOwner = input.lease.owner;
    updates.leaseExpiresAt = input.lease.expiresAt;
    updates.lastHeartbeatAt = input.lease.heartbeatAt;
  }

  const updated = await transaction
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, task.id))
    .returning();
  const persistedTask = updated[0];
  if (!persistedTask) throw new Error(`Task not found: ${task.id}`);

  await transaction.insert(stateTransitions).values({
    taskId: task.id,
    fromState: transition.from,
    toState: transition.to,
    reason: transition.reason ?? null,
  });

  return persistedTask;
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async getTask(taskId: string): Promise<PersistedTask | undefined> {
    const selected = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return selected[0];
  }

  async createTask(input: CreateTaskInput): Promise<PersistedTask> {
    if (input.workUnits.length === 0) throw new Error('Task requires at least one work unit');
    if (new Set(input.workUnits.map((workUnit) => workUnit.repository)).size !== input.workUnits.length) {
      throw new Error('Task work units must use unique repositories');
    }
    if (new Set(input.blockerTaskIds ?? []).size !== (input.blockerTaskIds?.length ?? 0)) {
      throw new Error('Task blockers must be unique');
    }

    return this.db.transaction(async (transaction) => {
      const inserted = await transaction.insert(tasks).values({
        linearIssueId: input.linearIssueId,
        linearIdentifier: input.linearIdentifier,
        contractSnapshot: input.contractSnapshot,
        complexity: input.complexity,
        risk: input.risk ?? null,
      }).returning();
      const task = inserted[0];
      if (!task) throw new Error('Failed to create task');

      await transaction.insert(taskWorkUnits).values(input.workUnits.map((workUnit) => ({
        taskId: task.id,
        repository: workUnit.repository,
        outcome: workUnit.outcome ?? null,
      })));

      if (input.blockerTaskIds && input.blockerTaskIds.length > 0) {
        await transaction.insert(taskDependencies).values(input.blockerTaskIds.map((blockerTaskId) => ({
          taskId: task.id,
          blockerTaskId,
        })));
      }

      return task;
    });
  }

  async upsertDiscoveredTask(input: CreateTaskInput): Promise<{ task: PersistedTask; created: boolean }> {
    const existing = await this.db.select().from(tasks).where(eq(tasks.linearIssueId, input.linearIssueId)).limit(1);
    if (existing[0]) {
      if (stableJson(existing[0].contractSnapshot) !== stableJson(input.contractSnapshot)) {
        throw new ContractChangedError(input.linearIssueId);
      }
      return { task: existing[0], created: false };
    }
    return { task: await this.createTask(input), created: true };
  }

  async replaceDependencies(taskId: string, blockerTaskIds: readonly string[]): Promise<void> {
    if (new Set(blockerTaskIds).size !== blockerTaskIds.length) throw new Error('Task blockers must be unique');
    await this.db.transaction(async (transaction) => {
      await transaction.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId));
      if (blockerTaskIds.length > 0) {
        await transaction.insert(taskDependencies).values(blockerTaskIds.map((blockerTaskId) => ({ taskId, blockerTaskId })));
      }
    });
  }

  async quarantineIntake(input: { linearIssueId: string; linearIdentifier: string; reason: string; payload: Record<string, unknown> }): Promise<void> {
    await this.db.insert(intakeQuarantines).values(input).onConflictDoUpdate({
      target: intakeQuarantines.linearIssueId,
      set: { linearIdentifier: input.linearIdentifier, reason: input.reason, payload: input.payload, lastSeenAt: new Date() },
    });
  }

  async claimNextQueuedTask(input: TaskClaimInput): Promise<PersistedTask | undefined> {
    return this.claimNextTask({
      ...input,
      maxConcurrentTasks: Number.POSITIVE_INFINITY,
      work: { queued: true, parkedStates: [], scheduleResumeStates: [], limitResumeStates: [] },
    });
  }

  /**
   * Claims one executable task under a database-wide advisory lock.
   * Every leased task counts toward `maxConcurrentTasks`, including leases that expired but are not yet recovered,
   * so the limit holds across processes.
   */
  async claimNextTask(input: TaskClaimWithLimitInput): Promise<PersistedTask | undefined> {
    if (input.leaseDurationMs <= 0) throw new Error('leaseDurationMs must be positive');
    const now = input.now ?? new Date();
    const { work } = input;
    const blockers = alias(tasks, 'blocker_tasks');

    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${claimLockName}))`);
      const leased = await transaction.select({ value: count() }).from(tasks).where(isNotNull(tasks.leaseOwner));
      if ((leased[0]?.value ?? 0) >= input.maxConcurrentTasks) return undefined;

      const eligibility: SQL[] = [];
      if (work.queued) {
        const unresolvedBlockers = transaction
          .select({ taskId: taskDependencies.taskId })
          .from(taskDependencies)
          .innerJoin(blockers, eq(taskDependencies.blockerTaskId, blockers.id))
          .where(and(eq(taskDependencies.taskId, tasks.id), ne(blockers.state, 'COMPLETED')));
        eligibility.push(and(eq(tasks.state, 'QUEUED'), notExists(unresolvedBlockers)) as SQL);
      }
      if (work.parkedStates.length > 0) {
        eligibility.push(inArray(tasks.state, [...work.parkedStates]));
      }
      if (work.scheduleResumeStates.length > 0) {
        eligibility.push(and(eq(tasks.state, 'PAUSED_SCHEDULE'), inArray(tasks.resumeState, [...work.scheduleResumeStates])) as SQL);
      }
      if (work.limitResumeStates.length > 0) {
        eligibility.push(and(
          eq(tasks.state, 'PAUSED_LIMIT'),
          inArray(tasks.resumeState, [...work.limitResumeStates]),
          or(isNull(tasks.resumeAfter), lte(tasks.resumeAfter, now)),
        ) as SQL);
      }
      if (eligibility.length === 0) return undefined;

      // Finish in-progress work before resuming paused work, and resume paused work before starting new work.
      const priority = sql`case when ${tasks.state} = 'QUEUED' then 2 when ${tasks.state} in ('PAUSED_SCHEDULE', 'PAUSED_LIMIT') then 1 else 0 end`;
      const candidates = await transaction
        .select()
        .from(tasks)
        .where(and(
          isNull(tasks.leaseOwner),
          eq(tasks.requiresManualIntervention, false),
          isNull(tasks.cancelRequestedAt),
          or(...eligibility),
        ))
        .orderBy(priority, asc(tasks.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const task = candidates[0];
      if (!task) return undefined;

      const lease = { owner: input.leaseOwner, expiresAt: new Date(now.getTime() + input.leaseDurationMs), heartbeatAt: now };
      if (task.state === 'QUEUED') {
        return transitionLockedTask(transaction, task, { to: 'ANALYZING', reason: 'Task claimed for analysis', lease });
      }
      if ((task.state === 'PAUSED_SCHEDULE' || task.state === 'PAUSED_LIMIT') && task.resumeState !== null) {
        return transitionLockedTask(transaction, task, { to: task.resumeState, reason: `Resumed from ${task.state}`, lease });
      }

      const updated = await transaction.update(tasks)
        .set({ leaseOwner: lease.owner, leaseExpiresAt: lease.expiresAt, lastHeartbeatAt: lease.heartbeatAt, updatedAt: now })
        .where(eq(tasks.id, task.id))
        .returning();
      if (!updated[0]) throw new Error(`Task not found: ${task.id}`);
      return updated[0];
    });
  }

  async transitionTask(input: TaskTransitionInput): Promise<PersistedTask> {
    return this.db.transaction(async (transaction) => {
      const selected = await transaction
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
        .for('update');
      const task = selected[0];
      if (!task) throw new Error(`Task not found: ${input.taskId}`);

      return transitionLockedTask(transaction, task, {
        to: input.to,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.resumeState === undefined ? {} : { resumeState: input.resumeState }),
        ...(input.pauseReason === undefined ? {} : { pauseReason: input.pauseReason }),
        ...(input.resumeAfter === undefined ? {} : { resumeAfter: input.resumeAfter }),
        ...(input.leaseOwner === undefined ? {} : { leaseOwner: input.leaseOwner }),
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        ...(input.requiresManualIntervention === undefined ? {} : { requiresManualIntervention: input.requiresManualIntervention }),
        ...(input.releaseLease ? { lease: clearedLease } : {}),
      });
    });
  }

  /**
   * Releases a lease without changing state, parking the task at a durable stage boundary.
   * Only the current owner may release, so a worker that lost its lease cannot clear another worker's lease.
   */
  async releaseLease(
    taskId: string,
    leaseOwner: string,
    patch: { lastError?: string; requiresManualIntervention?: boolean } = {},
  ): Promise<PersistedTask> {
    const updated = await this.db
      .update(tasks)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        updatedAt: new Date(),
        ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
        ...(patch.requiresManualIntervention === undefined ? {} : { requiresManualIntervention: patch.requiresManualIntervention }),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, leaseOwner)))
      .returning();
    const task = updated[0];
    if (!task) throw new LeaseOwnershipError(taskId);
    return task;
  }

  async heartbeat(taskId: string, leaseOwner: string, leaseDurationMs: number, now = new Date()): Promise<PersistedTask> {
    if (leaseDurationMs <= 0) throw new Error('leaseDurationMs must be positive');
    const updated = await this.db
      .update(tasks)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, leaseOwner)))
      .returning();
    const task = updated[0];
    if (!task) throw new LeaseOwnershipError(taskId);
    return task;
  }

  async recordCheckpoint(taskId: string, stage: TaskState, checkpointKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insert(taskCheckpoints).values({ taskId, stage, checkpointKey, payload })
      .onConflictDoUpdate({
        target: [taskCheckpoints.taskId, taskCheckpoints.checkpointKey],
        set: { stage, payload, completedAt: new Date() },
      });
  }

  async getCheckpoint(taskId: string, checkpointKey: string): Promise<Record<string, unknown> | undefined> {
    const selected = await this.db.select({ payload: taskCheckpoints.payload }).from(taskCheckpoints)
      .where(and(eq(taskCheckpoints.taskId, taskId), eq(taskCheckpoints.checkpointKey, checkpointKey)))
      .limit(1);
    return selected[0]?.payload;
  }

  async recordAttempt(input: {
    taskId: string;
    stage: TaskState;
    attempt: number;
    failureCategory?: string;
    result?: Record<string, unknown>;
    completedAt?: Date;
  }): Promise<void> {
    if (input.attempt <= 0) throw new Error('attempt must be positive');
    await this.db.insert(taskAttempts).values({
      taskId: input.taskId,
      stage: input.stage,
      attempt: input.attempt,
      failureCategory: input.failureCategory ?? null,
      result: input.result ?? null,
      completedAt: input.completedAt ?? null,
    }).onConflictDoUpdate({
      target: [taskAttempts.taskId, taskAttempts.stage, taskAttempts.attempt],
      set: {
        failureCategory: input.failureCategory ?? null,
        result: input.result ?? null,
        completedAt: input.completedAt ?? null,
      },
    });
  }

  async recordExternalOperation(input: {
    taskId: string;
    operationType: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
  }): Promise<typeof externalOperations.$inferSelect> {
    const inserted = await this.db.insert(externalOperations).values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];

    const existing = await this.db.select().from(externalOperations)
      .where(eq(externalOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    const operation = existing[0];
    if (!operation) throw new Error(`External operation not found: ${input.idempotencyKey}`);
    return operation;
  }

  async recoverExpiredLeases(now = new Date()): Promise<PersistedTask[]> {
    return this.recoverLeases(lt(tasks.leaseExpiresAt, now), 'Lease expired; manual recovery required');
  }

  /**
   * Recovers leases left by a previous incarnation of a worker with a stable identity.
   * Callers must invoke this only before the worker claims anything, because the identity must be unique per process.
   */
  async recoverLeasesOwnedBy(leaseOwner: string): Promise<PersistedTask[]> {
    return this.recoverLeases(eq(tasks.leaseOwner, leaseOwner), 'Worker restarted while holding lease; manual recovery required');
  }

  private async recoverLeases(condition: SQL, reason: string): Promise<PersistedTask[]> {
    return this.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(tasks)
        .where(and(isNotNull(tasks.leaseOwner), condition, notInArray(tasks.state, ['BLOCKED', 'COMPLETED', 'CANCELLED'])))
        .for('update', { skipLocked: true });
      const recovered: PersistedTask[] = [];

      for (const task of candidates) {
        if (canTransition(task.state, 'BLOCKED')) {
          recovered.push(await transitionLockedTask(transaction, task, {
            to: 'BLOCKED',
            reason,
            allowExpiredLease: true,
            requiresManualIntervention: true,
            lease: clearedLease,
          }));
          continue;
        }
        // States such as READY_FOR_HUMAN_REVIEW cannot enter BLOCKED; flag them without an illegal transition.
        const updated = await transaction.update(tasks)
          .set({ leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null, requiresManualIntervention: true, lastError: reason, updatedAt: new Date() })
          .where(eq(tasks.id, task.id))
          .returning();
        if (updated[0]) recovered.push(updated[0]);
      }

      return recovered;
    });
  }
}
