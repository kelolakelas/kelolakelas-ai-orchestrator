import { DateTime } from 'luxon';
import type { OrchestratorConfig } from '../config/schema.js';
import { discoverLinearIssues, persistLinearIntake } from '../intake/linear-discovery.js';
import type { SchedulerObserver } from '../observability/orchestrator-metrics.js';
import type { LinearProvider } from '../providers/linear.js';
import type { OperatorRepository, OrchestratorControls } from '../repositories/operator.repository.js';
import { LeaseOwnershipError, type ClaimableWork, type PersistedTask, type TaskRepository } from '../repositories/task.repository.js';
import { operationGate, shouldInterruptRunningStage, stageGate } from '../scheduling/stage-gate.js';
import { claimLaneOf, isProviderLimitPause, transitionMap, type ClaimLane, type TaskState } from '../types/domain.js';
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
  /**
   * Engages the kill switch for this process regardless of the database, for example from `ORCHESTRATOR_KILL_SWITCH`
   * when PostgreSQL is untrusted after a restore.
   */
  forceKillSwitch?: boolean;
  observer?: SchedulerObserver;
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

export interface LaneHold {
  until: Date;
  reason: string;
}

export interface SchedulerStatus {
  workerId: string;
  dryRun: boolean;
  started: boolean;
  stopping: boolean;
  lastTick: { startedAt: Date | null; completedAt: Date | null; error: string | null };
  lastIntake: IntakeStatus | null;
  controls: Pick<OrchestratorControls, 'pauseNewWork' | 'scheduleOverride' | 'killSwitch'> | null;
  /** `environment` when `ORCHESTRATOR_KILL_SWITCH` forces the kill switch on this worker. */
  killSwitchSource: 'database' | 'environment' | null;
  /** Active backpressure: claims in a lane are held until the given time. */
  laneHolds: Partial<Record<ClaimLane, LaneHold>>;
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
  private readonly laneHolds: Partial<Record<ClaimLane, LaneHold>> = {};

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
      this.options.observer?.leasesRecovered('restart', recovered.length);
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
      controls: this.controls === undefined ? null : { pauseNewWork: this.controls.pauseNewWork, scheduleOverride: this.controls.scheduleOverride, killSwitch: this.killSwitchEngaged() },
      killSwitchSource: this.options.forceKillSwitch ? 'environment' : this.controls?.killSwitch ? 'database' : null,
      laneHolds: this.activeLaneHolds(),
      inFlight: [...this.inFlight.values()].map(({ taskId, linearIdentifier, stage, since }) => ({ taskId, linearIdentifier, stage, since })),
    };
  }

  /**
   * Re-reads operator controls and applies the kill switch to in-flight stages immediately. Other workers apply it at
   * their next heartbeat.
   */
  async refreshControls(): Promise<void> {
    this.controls = await this.options.operator.getControls();
    if (this.killSwitchEngaged()) this.abortInFlight('kill-switch');
  }

  /**
   * Holds new claims in a lane until `until`, for example while a provider circuit is open or the model runner reported a
   * usage limit that every other task would hit too. A later hold extends an earlier one.
   */
  holdLane(lane: ClaimLane, until: Date, reason: string): void {
    const current = this.laneHolds[lane];
    if (current !== undefined && current.until >= until) return;
    this.laneHolds[lane] = { until, reason };
    this.options.log('claim_lane_held', { lane, until, reason });
  }

  private activeLaneHolds(): Partial<Record<ClaimLane, LaneHold>> {
    const now = this.now();
    const active: Partial<Record<ClaimLane, LaneHold>> = {};
    for (const lane of ['execution', 'delivery'] as const) {
      const hold = this.laneHolds[lane];
      if (hold !== undefined && hold.until > now) active[lane] = { ...hold };
    }
    return active;
  }

  private killSwitchEngaged(): boolean {
    return this.options.forceKillSwitch === true || this.controls?.killSwitch === true;
  }

  private abortInFlight(reason: StageAbortReason): void {
    for (const entry of this.inFlight.values()) entry.controller?.abort(reason);
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
    const startedAt = Date.now();
    const { dryRun, tasks } = this.options;
    try {
      this.controls = await this.options.operator.getControls();
      const killSwitch = this.killSwitchEngaged();
      if (killSwitch) this.abortInFlight('kill-switch');
      const recovered = dryRun ? [] : await tasks.recoverExpiredLeases(this.now());
      this.logRecovered('scheduler_expired_leases_recovered', recovered);
      this.options.observer?.leasesRecovered('expired', recovered.length);
      // Maintenance changes worktrees and records, so the kill switch stops it too. Intake stays on: it is read-only.
      if (!dryRun && !killSwitch) await this.runMaintenance();
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
        killSwitch,
      });
      this.lastTick = { ...this.lastTick, completedAt: this.now() };
      this.options.observer?.tickCompleted(Date.now() - startedAt, true, this.now());
    } catch (error) {
      const message = errorMessage(error);
      this.lastTick = { ...this.lastTick, completedAt: this.now(), error: message };
      this.options.log('scheduler_tick_failed', { error: message });
      this.options.observer?.tickCompleted(Date.now() - startedAt, false, this.now());
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
      this.options.observer?.intakePolled(true, this.now());
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
      this.options.observer?.intakePolled(false, this.now());
      this.options.log('linear_intake_failed', { error: message });
    }
  }

  private async claimAvailableWork(): Promise<number> {
    const controls = this.controls;
    if (this.options.dryRun || this.stopping || controls === undefined || controls.pauseNewWork || this.killSwitchEngaged()) return 0;
    const work = this.claimableWork(controls);
    const { maxConcurrentTasks, maxConcurrentDeliveryTasks } = this.config.orchestrator;
    // A lane refills its slots as claimed tasks finish. When stages finish quickly, as delivery observations of many
    // waiting pull requests do, that refill never runs out of claimable work, so each lane claims for at most one polling
    // interval. The tick then finishes, polls intake, and gives the other lane its turn.
    return await this.claimLane('execution', work, maxConcurrentTasks) + await this.claimLane('delivery', work, maxConcurrentDeliveryTasks);
  }

  private async claimLane(lane: ClaimLane, work: ClaimableWork, limit: number): Promise<number> {
    const hasWork = lane === 'delivery'
      ? work.parkedStates.some((state) => claimLaneOf(state) === 'delivery')
      : work.queued || work.parkedStates.some((state) => claimLaneOf(state) === 'execution') || work.scheduleResumeStates.length > 0 || work.limitResumeStates.length > 0;
    if (!hasWork) return 0;
    const hold = this.activeLaneHolds()[lane];
    if (hold !== undefined) return 0;
    let claimed = 0;
    const deadline = Date.now() + this.timing.pollIntervalMs;
    while (!this.stopping && this.inFlightIn(lane) < limit && Date.now() < deadline) {
      const task = await this.options.tasks.claimNextTask({
        leaseOwner: this.options.workerId,
        leaseDurationMs: this.timing.leaseDurationMs,
        maxConcurrentTasks: limit,
        now: this.now(),
        work,
        lane,
        repositoryLimits: this.repositoryLimits(),
        rollout: this.config.orchestrator.rollout,
      });
      if (!task) break;
      claimed += 1;
      this.startTask(task);
    }
    return claimed;
  }

  private repositoryLimits(): Record<string, number> {
    const limits: Record<string, number> = {};
    for (const [name, repository] of Object.entries(this.config.repositories)) {
      if (repository?.maxConcurrentTasks !== undefined) limits[name] = repository.maxConcurrentTasks;
    }
    return limits;
  }

  private inFlightIn(lane: ClaimLane): number {
    return [...this.inFlight.values()].filter((entry) => claimLaneOf(entry.stage) === lane).length;
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
    let stageRunning: { stage: TaskState; startedAt: number } | undefined;
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
        if (this.killSwitchEngaged()) {
          entry.controller?.abort('kill-switch' satisfies StageAbortReason);
          return;
        }
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
        if (this.killSwitchEngaged()) {
          await tasks.releaseLease(task.id, workerId);
          this.options.log('task_parked', { ...fields(task), reason: 'kill_switch' });
          this.options.observer?.taskParked('kill_switch');
          return;
        }
        if (this.controls.pauseNewWork) {
          await tasks.releaseLease(task.id, workerId);
          this.options.log('task_parked', { ...fields(task), reason: 'pause_new_work' });
          this.options.observer?.taskParked('pause_new_work');
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
        const stageStartedAt = Date.now();
        stageRunning = { stage: stageTask.state, startedAt: stageStartedAt };
        const outcome = await handler.run({
          task: stageTask,
          signal: controller.signal,
          checkpoint: (key, payload) => tasks.recordCheckpoint(stageTask.id, stageTask.state, key, payload),
          getCheckpoint: (key) => tasks.getCheckpoint(stageTask.id, key),
          log: (event, extra) => this.options.log(event, { ...extra, ...fields(stageTask) }),
        });
        entry.controller = undefined;
        stageRunning = undefined;
        this.options.observer?.stageFinished(stageTask.state, outcome.kind, Date.now() - stageStartedAt);
        if (leaseLost) return;

        switch (outcome.kind) {
          case 'advance':
            await this.observeStateExit(stageTask);
            task = await tasks.transitionTask({
              taskId: task.id,
              to: outcome.to,
              reason: outcome.reason ?? `${task.state} stage completed`,
              leaseOwner: workerId,
              ...(outcome.incrementCounter === undefined ? {} : { incrementCounter: outcome.incrementCounter }),
              ...(outcome.lastError === undefined ? {} : { lastError: outcome.lastError?.slice(0, maxErrorLength) ?? null }),
              ...(outcome.requiresManualIntervention === undefined ? {} : { requiresManualIntervention: outcome.requiresManualIntervention }),
            });
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
            // Provider limits are account-wide: starting or resuming other tasks now would only hit the same limit.
            if (isProviderLimitPause(outcome.pauseReason) && task.resumeAfter !== null) {
              this.holdLane('execution', task.resumeAfter, `runner ${outcome.pauseReason}`);
            }
            return;
          case 'wait':
            task = await tasks.deferTask(task.id, workerId, outcome.until, outcome.lastError === undefined ? undefined : outcome.lastError?.slice(0, maxErrorLength) ?? null);
            this.options.log('task_waiting', { ...fields(stageTask), until: outcome.until, reason: outcome.reason });
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
      if (stageRunning !== undefined) this.options.observer?.stageFinished(stageRunning.stage, 'failed', Date.now() - stageRunning.startedAt);
      await this.failTask(task, error);
    } finally {
      clearInterval(heartbeat);
      entry.controller = undefined;
    }
  }

  private async observeStateExit(task: PersistedTask): Promise<void> {
    if (this.options.observer === undefined) return;
    try {
      const enteredAt = await this.options.tasks.stateEnteredAt(task.id, task.state);
      if (enteredAt !== undefined) this.options.observer.stateExited(task.state, (this.now().getTime() - enteredAt.getTime()) / 1_000);
    } catch {
      // Metrics never affect workflow progress.
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
