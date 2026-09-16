import { DateTime } from 'luxon';
import type { OrchestratorConfig } from '../config/schema.js';
import { discoverLinearIssues, persistLinearIntake } from '../intake/linear-discovery.js';
import type { LinearProvider } from '../providers/linear.js';
import type { OperatorRepository, OrchestratorControls } from '../repositories/operator.repository.js';
import { LeaseOwnershipError, type ClaimableWork, type PersistedTask, type TaskRepository } from '../repositories/task.repository.js';
import { operationGate, shouldInterruptRunningStage, stageGate } from '../scheduling/stage-gate.js';
import { transitionMap, type TaskState } from '../types/domain.js';
import { canTransition } from './state-machine.js';
import type { StageAbortReason, StageHandlers } from './stage-handler.js';

export type SchedulerLog = (event: string, fields?: Record<string, unknown>) => void;

export interface SchedulerTiming {
  pollIntervalMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  shutdownGraceMs: number;
  usageLimitPauseMs: number;
  /** A tick running longer than this marks the worker as not live. */
  stuckTickMs: number;
}

/** Deterministic housekeeping run on every non-dry-run tick, such as releasing workspaces of terminal tasks. */
export interface MaintenanceTask {
  readonly name: string;
  run(): Promise<void>;
}

export interface SchedulerOptions {
  config: OrchestratorConfig;
  linear: LinearProvider;
  tasks: TaskRepository;
  operator: OperatorRepository;
  workerId: string;
  dryRun: boolean;
  log: SchedulerLog;
  handlers?: StageHandlers;
  maintenance?: readonly MaintenanceTask[];
  /** Set only when `workerId` is stable and unique per process, such as a systemd instance identity. */
  recoverOwnLeasesOnStart?: boolean;
  clock?: () => Date;
  timing?: Partial<SchedulerTiming>;
}

interface InFlightTask {
  taskId: string;
  linearIdentifier: string;
  stage: TaskState;
  since: Date;
  controller: AbortController | undefined;
  done: Promise<void>;
}

interface IntakeStatus {
  at: Date;
  ok: boolean;
  eligible?: number;
  quarantined?: number;
  ignored?: number;
  error?: string;
}

export interface SchedulerStatus {
  workerId: string;
  dryRun: boolean;
  started: boolean;
  stopping: boolean;
  lastTick: { startedAt: Date | null; completedAt: Date | null; error: string | null };
  lastIntake: IntakeStatus | null;
  controls: Pick<OrchestratorControls, 'pauseNewWork' | 'scheduleOverride'> | null;
  inFlight: Array<{ taskId: string; linearIdentifier: string; stage: TaskState; since: Date }>;
}

const maxErrorLength = 1_000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return message.length > maxErrorLength ? `${message.slice(0, maxErrorLength)}…` : message;
}

function abortReason(signal: AbortSignal): StageAbortReason | undefined {
  return signal.aborted ? signal.reason as StageAbortReason : undefined;
}

/**
 * Long-running worker loop. Each tick recovers expired leases, polls Linear intake, and claims executable tasks up to
 * the database-wide concurrency limit. Claimed tasks run stage by stage through registered handlers, heartbeating their
 * lease and re-checking operator controls and the schedule at every stage boundary.
 */
export class Scheduler {
  private readonly config: OrchestratorConfig;
  private readonly handlers: StageHandlers;
  private readonly timing: SchedulerTiming;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, InFlightTask>();
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> | undefined;
  private started = false;
  private stopping = false;
  private controls: OrchestratorControls | undefined;
  private lastTick: SchedulerStatus['lastTick'] = { startedAt: null, completedAt: null, error: null };
  private lastIntake: IntakeStatus | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.config = options.config;
    this.handlers = options.handlers ?? {};
    this.now = options.clock ?? (() => new Date());
    const orchestrator = options.config.orchestrator;
    this.timing = {
      pollIntervalMs: orchestrator.pollingIntervalSeconds * 1_000,
      leaseDurationMs: orchestrator.leaseDurationSeconds * 1_000,
      heartbeatIntervalMs: orchestrator.heartbeatIntervalSeconds * 1_000,
      shutdownGraceMs: orchestrator.shutdownGracePeriodSeconds * 1_000,
      usageLimitPauseMs: orchestrator.usageLimitPauseMinutes * 60_000,
      stuckTickMs: Math.max(5 * 60_000, orchestrator.pollingIntervalSeconds * 3_000),
      ...options.timing,
    };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Scheduler already started');
    this.started = true;
    if (!this.options.dryRun && this.options.recoverOwnLeasesOnStart) {
      const recovered = await this.options.tasks.recoverLeasesOwnedBy(this.options.workerId);
      this.logRecovered('scheduler_owned_leases_recovered', recovered);
    }
    await this.runTick();
  }

  /**
   * Stops claiming, asks running stages to stop at a safe point, and waits up to the grace period. A stage that does not
   * finish in time keeps its lease; the lease expires and recovery blocks the task for manual intervention.
   */
  async stop(): Promise<{ abandonedTaskIds: string[] }> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.inFlight.values()) entry.controller?.abort('shutdown' satisfies StageAbortReason);

    const drained = (async () => {
      await this.currentTick;
      await Promise.all([...this.inFlight.values()].map((entry) => entry.done));
    })();
    let graceTimer: NodeJS.Timeout | undefined;
    const graceElapsed = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, this.timing.shutdownGraceMs); });
    await Promise.race([drained, graceElapsed]);
    clearTimeout(graceTimer);

    const abandonedTaskIds = [...this.inFlight.keys()];
    this.options.log('scheduler_stopped', { workerId: this.options.workerId, abandonedTaskIds });
    return { abandonedTaskIds };
  }

  /** Runs one tick immediately. Concurrent calls share the tick already in progress. */
  async runOnce(): Promise<void> {
    if (this.currentTick) return this.currentTick;
    if (this.stopping) return;
    this.currentTick = this.tick().finally(() => { this.currentTick = undefined; });
    return this.currentTick;
  }

  /** Waits for every claimed task to reach a stage boundary where it released its lease. Intended for tests. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()].map((entry) => entry.done));
  }

  isLive(): boolean {
    const { startedAt, completedAt } = this.lastTick;
    const tickRunning = startedAt !== null && (completedAt === null || completedAt < startedAt);
    return !(tickRunning && this.now().getTime() - startedAt.getTime() > this.timing.stuckTickMs);
  }

  status(): SchedulerStatus {
    return {
      workerId: this.options.workerId,
      dryRun: this.options.dryRun,
      started: this.started,
      stopping: this.stopping,
      lastTick: { ...this.lastTick },
      lastIntake: this.lastIntake === null ? null : { ...this.lastIntake },
      controls: this.controls === undefined ? null : { pauseNewWork: this.controls.pauseNewWork, scheduleOverride: this.controls.scheduleOverride },
      inFlight: [...this.inFlight.values()].map(({ taskId, linearIdentifier, stage, since }) => ({ taskId, linearIdentifier, stage, since })),
    };
  }

  private async runTick(): Promise<void> {
    await this.runOnce();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.runTick(), this.timing.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    this.lastTick = { startedAt: this.now(), completedAt: null, error: null };
    const { dryRun, tasks } = this.options;
    try {
      this.controls = await this.options.operator.getControls();
      const recovered = dryRun ? [] : await tasks.recoverExpiredLeases(this.now());
      this.logRecovered('scheduler_expired_leases_recovered', recovered);
      if (!dryRun) await this.runMaintenance();
      await this.pollIntake();
      const claimed = await this.claimAvailableWork();
      this.options.log('scheduler_tick_completed', {
        dryRun,
        eligible: this.lastIntake?.eligible ?? 0,
        quarantined: this.lastIntake?.quarantined ?? 0,
        ignored: this.lastIntake?.ignored ?? 0,
        intakeOk: this.lastIntake?.ok ?? false,
        recovered: recovered.length,
        claimed,
        inFlight: this.inFlight.size,
        pauseNewWork: this.controls.pauseNewWork,
        scheduleOverride: this.controls.scheduleOverride,
      });
      this.lastTick = { ...this.lastTick, completedAt: this.now() };
    } catch (error) {
      const message = errorMessage(error);
      this.lastTick = { ...this.lastTick, completedAt: this.now(), error: message };
      this.options.log('scheduler_tick_failed', { error: message });
    }
  }

  private async runMaintenance(): Promise<void> {
    for (const task of this.options.maintenance ?? []) {
      try {
        await task.run();
      } catch (error) {
        this.options.log('maintenance_failed', { maintenance: task.name, error: errorMessage(error) });
      }
    }
  }

  /** Linear discovery is read-only, so it runs on every tick regardless of schedule or pause state. */
  private async pollIntake(): Promise<void> {
    try {
      const report = discoverLinearIssues(await this.options.linear.listIssues(), this.config.linear.requiredLabels, this.config.linear.excludedLabels);
      if (!this.options.dryRun) await persistLinearIntake(this.options.tasks, report);
      this.lastIntake = { at: this.now(), ok: true, eligible: report.eligible.length, quarantined: report.quarantined.length, ignored: report.ignored.length };
      if (this.options.dryRun) {
        this.options.log('linear_intake_dry_run_report', {
          eligible: report.eligible.map((issue) => issue.source?.linearIdentifier ?? issue.draftKey),
          quarantined: report.quarantined.map(({ identifier, reason }) => ({ identifier, reason })),
          ignored: report.ignored,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      this.lastIntake = { at: this.now(), ok: false, error: message };
      this.options.log('linear_intake_failed', { error: message });
    }
  }

  private async claimAvailableWork(): Promise<number> {
    const controls = this.controls;
    if (this.options.dryRun || this.stopping || controls === undefined || controls.pauseNewWork) return 0;
    const work = this.claimableWork(controls);
    let claimed = 0;
    while (!this.stopping && this.inFlight.size < this.config.orchestrator.maxConcurrentTasks) {
      const task = await this.options.tasks.claimNextTask({
        leaseOwner: this.options.workerId,
        leaseDurationMs: this.timing.leaseDurationMs,
        maxConcurrentTasks: this.config.orchestrator.maxConcurrentTasks,
        now: this.now(),
        work,
      });
      if (!task) break;
      claimed += 1;
      this.startTask(task);
    }
    return claimed;
  }

  /** Translates handlers, schedule gates, and the operator override into the claim query's eligibility. */
  claimableWork(controls: Pick<OrchestratorControls, 'scheduleOverride'>): ClaimableWork {
    const now = this.scheduleNow();
    const permitted = (Object.keys(this.handlers) as TaskState[])
      .filter((state) => stageGate(this.config, state, controls.scheduleOverride, now)?.permitted === true);
    const queued = permitted.includes('ANALYZING')
      && operationGate(this.config, 'TASK_DISCOVERY', controls.scheduleOverride, now).permitted;
    return {
      queued,
      parkedStates: permitted,
      scheduleResumeStates: permitted.filter((state) => transitionMap.PAUSED_SCHEDULE.includes(state)),
      limitResumeStates: permitted.filter((state) => transitionMap.PAUSED_LIMIT.includes(state)),
    };
  }

  private startTask(task: PersistedTask): void {
    const entry: InFlightTask = {
      taskId: task.id,
      linearIdentifier: task.linearIdentifier,
      stage: task.state,
      since: this.now(),
      controller: undefined,
      done: Promise.resolve(),
    };
    this.inFlight.set(task.id, entry);
    entry.done = this.runTask(task, entry).finally(() => { this.inFlight.delete(task.id); });
  }

  private async runTask(claimed: PersistedTask, entry: InFlightTask): Promise<void> {
    const { tasks, workerId } = this.options;
    const fields = (task: PersistedTask) => ({ taskId: task.id, linearIdentifier: task.linearIdentifier, stage: task.state, workerId });
    let leaseLost = false;
    let task = claimed;
    this.options.log('task_claimed', fields(task));

    let heartbeatInProgress = false;
    const heartbeat = setInterval(() => void (async () => {
      // Never overlap heartbeats: on a slow database, piled-up renewals would exhaust the connection pool.
      if (heartbeatInProgress) return;
      heartbeatInProgress = true;
      try {
        const current = await tasks.heartbeat(task.id, workerId, this.timing.leaseDurationMs, this.now());
        if (current.cancelRequestedAt !== null || current.requiresManualIntervention) {
          entry.controller?.abort('operator' satisfies StageAbortReason);
          return;
        }
        this.controls = await this.options.operator.getControls();
        if (shouldInterruptRunningStage(this.config, current.state, this.controls.scheduleOverride, this.scheduleNow())) {
          entry.controller?.abort('schedule' satisfies StageAbortReason);
        }
      } catch (error) {
        if (error instanceof LeaseOwnershipError) {
          leaseLost = true;
          entry.controller?.abort('lease-lost' satisfies StageAbortReason);
          this.options.log('task_lease_lost', fields(task));
          return;
        }
        // A transient failure is tolerated: one missed heartbeat cannot expire the lease by configuration.
        this.options.log('task_heartbeat_failed', { ...fields(task), error: errorMessage(error) });
      } finally {
        heartbeatInProgress = false;
      }
    })(), this.timing.heartbeatIntervalMs);

    try {
      for (;;) {
        const current = await tasks.getTask(task.id);
        if (!current || current.leaseOwner !== workerId) {
          leaseLost = true;
          this.options.log('task_lease_lost', fields(task));
          return;
        }
        task = current;
        entry.stage = task.state;

        if (task.cancelRequestedAt !== null && canTransition(task.state, 'CANCELLED')) {
          task = await tasks.transitionTask({ taskId: task.id, to: 'CANCELLED', reason: 'Operator cancellation applied at stage boundary', leaseOwner: workerId, releaseLease: true });
          this.options.log('task_cancelled', fields(task));
          return;
        }
        if (task.requiresManualIntervention) {
          task = canTransition(task.state, 'BLOCKED')
            ? await tasks.transitionTask({ taskId: task.id, to: 'BLOCKED', reason: 'Manual intervention requested', leaseOwner: workerId, releaseLease: true })
            : await tasks.releaseLease(task.id, workerId);
          this.options.log('task_manual_intervention', fields(task));
          return;
        }
        if (this.stopping) {
          await tasks.releaseLease(task.id, workerId);
          this.options.log('task_parked', { ...fields(task), reason: 'shutdown' });
          return;
        }

        this.controls = await this.options.operator.getControls();
        if (this.controls.pauseNewWork) {
          await tasks.releaseLease(task.id, workerId);
          this.options.log('task_parked', { ...fields(task), reason: 'pause_new_work' });
          return;
        }
        const handler = this.handlers[task.state];
        if (!handler) {
          await tasks.releaseLease(task.id, workerId);
          this.options.log('task_parked', { ...fields(task), reason: 'no_stage_handler' });
          return;
        }
        const gate = stageGate(this.config, task.state, this.controls.scheduleOverride, this.scheduleNow());
        if (!gate?.permitted) {
          if (canTransition(task.state, 'PAUSED_SCHEDULE')) {
            task = await tasks.transitionTask({
              taskId: task.id,
              to: 'PAUSED_SCHEDULE',
              resumeState: task.state,
              pauseReason: 'OPERATING_HOURS_ENDED',
              reason: `Schedule gate closed: ${gate?.reason ?? 'no operation'}`,
              leaseOwner: workerId,
              releaseLease: true,
            });
          } else {
            await tasks.releaseLease(task.id, workerId);
          }
          this.options.log('task_paused_schedule', { ...fields(task), gate: gate?.reason });
          return;
        }

        const controller = new AbortController();
        entry.controller = controller;
        if (this.stopping) controller.abort('shutdown' satisfies StageAbortReason);
        const stageTask = task;
        this.options.log('stage_started', fields(stageTask));
        const outcome = await handler.run({
          task: stageTask,
          signal: controller.signal,
          checkpoint: (key, payload) => tasks.recordCheckpoint(stageTask.id, stageTask.state, key, payload),
          getCheckpoint: (key) => tasks.getCheckpoint(stageTask.id, key),
          log: (event, extra) => this.options.log(event, { ...extra, ...fields(stageTask) }),
        });
        entry.controller = undefined;
        if (leaseLost) return;

        switch (outcome.kind) {
          case 'advance':
            task = await tasks.transitionTask({ taskId: task.id, to: outcome.to, reason: outcome.reason ?? `${task.state} stage completed`, leaseOwner: workerId });
            this.options.log('stage_completed', { ...fields(stageTask), to: task.state });
            break;
          case 'pause-limit':
            task = await tasks.transitionTask({
              taskId: task.id,
              to: 'PAUSED_LIMIT',
              resumeState: task.state,
              pauseReason: outcome.pauseReason,
              resumeAfter: outcome.resumeAfter ?? new Date(this.now().getTime() + this.timing.usageLimitPauseMs),
              reason: outcome.reason ?? `Paused for ${outcome.pauseReason}`,
              leaseOwner: workerId,
              releaseLease: true,
            });
            this.options.log('task_paused_limit', { ...fields(task), resumeAfter: task.resumeAfter });
            return;
          case 'interrupted': {
            const reason = abortReason(controller.signal);
            if (reason === undefined) throw new Error('Stage handler reported interruption without an abort request');
            this.options.log('stage_interrupted', { ...fields(stageTask), abortReason: reason });
            // The next boundary check applies the cause: shutdown parks, operator actions apply, schedule pauses.
            break;
          }
        }
      }
    } catch (error) {
      if (leaseLost || error instanceof LeaseOwnershipError) {
        this.options.log('task_lease_lost', fields(task));
        return;
      }
      await this.failTask(task, error);
    } finally {
      clearInterval(heartbeat);
      entry.controller = undefined;
    }
  }

  /** Hands a failed stage to an operator. An unrecorded outcome must never be retried automatically. */
  private async failTask(task: PersistedTask, error: unknown): Promise<void> {
    const { tasks, workerId } = this.options;
    const message = errorMessage(error);
    const fields = { taskId: task.id, linearIdentifier: task.linearIdentifier, stage: task.state, workerId, error: message };
    try {
      const current = await tasks.getTask(task.id);
      if (!current || current.leaseOwner !== workerId) return;
      if (canTransition(current.state, 'BLOCKED')) {
        await tasks.transitionTask({ taskId: current.id, to: 'BLOCKED', reason: 'Stage failed; manual intervention required', leaseOwner: workerId, releaseLease: true, lastError: message, requiresManualIntervention: true });
      } else {
        await tasks.releaseLease(current.id, workerId, { lastError: message, requiresManualIntervention: true });
      }
      this.options.log('task_stage_failed', fields);
    } catch (handoffError) {
      // Keep the lease: it expires and recovery blocks the task, which is the conservative outcome.
      this.options.log('task_failure_handoff_failed', { ...fields, handoffError: errorMessage(handoffError) });
    }
  }

  private scheduleNow(): DateTime {
    return DateTime.fromJSDate(this.now()).setZone(this.config.timezone);
  }

  private logRecovered(event: string, recovered: readonly PersistedTask[]): void {
    for (const task of recovered) {
      this.options.log(event, { taskId: task.id, linearIdentifier: task.linearIdentifier, stage: task.state, workerId: this.options.workerId });
    }
  }
}
