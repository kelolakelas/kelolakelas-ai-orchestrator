import type { ModelPrice } from '../config/schema.js';
import type { CircuitEvents, CircuitState } from '../providers/circuit-breaker.js';
import type { OperationalSnapshot } from '../repositories/metrics.repository.js';
import { taskStates, type ClaimLane, type TaskState } from '../types/domain.js';
import { MetricsRegistry } from './metrics.js';

/** Scheduler events that operators alert on. The scheduler depends on this port, not on Prometheus. */
export interface SchedulerObserver {
  tickCompleted(durationMs: number, ok: boolean, at: Date): void;
  intakePolled(ok: boolean, at: Date): void;
  stageFinished(stage: TaskState, outcome: 'advance' | 'pause-limit' | 'wait' | 'interrupted' | 'failed', durationMs: number): void;
  /** A task left `state` after spending `seconds` in it, for example the CI wait of `WAITING_CI`. */
  stateExited(state: TaskState, seconds: number): void;
  leasesRecovered(reason: 'expired' | 'restart', count: number): void;
  taskParked(reason: string): void;
}

export interface SchedulerGaugeSource {
  inFlight: Array<{ stage: TaskState; since: Date }>;
  controls: { pauseNewWork: boolean; killSwitch: boolean } | null;
  laneHolds: Partial<Record<ClaimLane, { until: Date; reason: string }>>;
}

const stageBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200];
const dwellBuckets = [60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 86_400, 172_800, 604_800];
const circuitValue: Record<CircuitState, number> = { closed: 0, 'half-open': 1, open: 2 };

/** Every metric the orchestrator exports, with the collectors that refresh state-derived values at scrape time. */
export class OrchestratorMetrics implements SchedulerObserver {
  readonly registry = new MetricsRegistry();

  private readonly ticks = this.registry.counter('orchestrator_scheduler_ticks_total', 'Scheduler ticks by result.', ['result']);
  private readonly tickDuration = this.registry.histogram('orchestrator_scheduler_tick_duration_seconds', 'Duration of scheduler ticks.', [], [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]);
  private readonly lastTick = this.registry.gauge('orchestrator_scheduler_last_tick_timestamp_seconds', 'Completion time of the last scheduler tick.');
  private readonly intakeLastSuccess = this.registry.gauge('orchestrator_intake_last_success_timestamp_seconds', 'Time of the last successful Linear intake poll.');
  private readonly intakePolls = this.registry.counter('orchestrator_intake_polls_total', 'Linear intake polls by result.', ['result']);
  private readonly stageRuns = this.registry.counter('orchestrator_stage_runs_total', 'Stage handler runs by stage and outcome.', ['stage', 'outcome']);
  private readonly stageDuration = this.registry.histogram('orchestrator_stage_duration_seconds', 'Stage handler run duration.', ['stage', 'outcome'], stageBuckets);
  private readonly stateDwell = this.registry.histogram('orchestrator_state_dwell_seconds', 'Time a task spent in a state before leaving it. WAITING_CI is the CI wait.', ['state'], dwellBuckets);
  private readonly leasesRecoveredTotal = this.registry.counter('orchestrator_leases_recovered_total', 'Stale leases recovered for manual intervention.', ['reason']);
  private readonly parked = this.registry.counter('orchestrator_tasks_parked_total', 'Tasks parked at a stage boundary by reason.', ['reason']);
  private readonly providerCalls = this.registry.counter('orchestrator_provider_calls_total', 'Provider calls through circuit breakers by result.', ['provider', 'result']);
  private readonly circuitState = this.registry.gauge('orchestrator_provider_circuit_state', 'Provider circuit state: 0 closed, 1 half-open, 2 open.', ['provider']);
  private readonly retentionPruned = this.registry.counter('orchestrator_retention_pruned_total', 'Records and directories removed by retention.', ['kind']);

  private readonly tasks = this.registry.gauge('orchestrator_tasks', 'Tasks by current state.', ['state']);
  private readonly stateAge = this.registry.gauge('orchestrator_task_state_age_seconds_max', 'Longest time any task has been in its current state.', ['state']);
  private readonly staleLeases = this.registry.gauge('orchestrator_leases_stale', 'Leases past expiry that recovery has not processed yet.');
  private readonly manual = this.registry.gauge('orchestrator_tasks_manual_intervention', 'Unfinished tasks waiting for manual intervention.');
  private readonly quarantined = this.registry.gauge('orchestrator_intake_quarantined', 'Linear issues quarantined by intake.');
  private readonly awaitingMerge = this.registry.gauge('orchestrator_pull_requests_awaiting_merge', 'Open orchestrator pull requests not yet merged.');
  private readonly attempts = this.registry.counter('orchestrator_attempts_total', 'Recorded stage attempts by stage and failure category (succeeded when none).', ['stage', 'category']);
  private readonly tokens = this.registry.counter('orchestrator_model_tokens_total', 'Runner tokens by model and kind.', ['model', 'kind']);
  private readonly cost = this.registry.counter('orchestrator_model_cost_usd_total', 'Estimated runner spend from metrics.modelPricing.', ['model']);
  private readonly inFlight = this.registry.gauge('orchestrator_in_flight_tasks', 'Tasks this worker is running, by lane.', ['lane']);
  private readonly inFlightAge = this.registry.gauge('orchestrator_in_flight_stage_age_seconds_max', 'Longest-running in-flight stage on this worker.');
  private readonly killSwitch = this.registry.gauge('orchestrator_kill_switch_engaged', 'Whether the kill switch is engaged (1) as last read by this worker.');
  private readonly pauseNewWork = this.registry.gauge('orchestrator_new_work_paused', 'Whether pause-new-work is set (1) as last read by this worker.');
  private readonly laneHold = this.registry.gauge('orchestrator_claim_lane_held', 'Whether backpressure currently holds claims in a lane (1).', ['lane']);

  constructor(private readonly clock: () => Date = () => new Date()) {
    this.registry.gauge('orchestrator_build_info', 'Constant 1, labelled with the service version.', ['version']).set({ version: process.env.npm_package_version ?? 'unknown' }, 1);
  }

  tickCompleted(durationMs: number, ok: boolean, at: Date): void {
    this.ticks.inc({ result: ok ? 'ok' : 'failed' });
    this.tickDuration.observe({}, durationMs / 1_000);
    this.lastTick.set({}, at.getTime() / 1_000);
  }

  intakePolled(ok: boolean, at: Date): void {
    this.intakePolls.inc({ result: ok ? 'ok' : 'failed' });
    if (ok) this.intakeLastSuccess.set({}, at.getTime() / 1_000);
  }

  stageFinished(stage: TaskState, outcome: Parameters<SchedulerObserver['stageFinished']>[1], durationMs: number): void {
    this.stageRuns.inc({ stage, outcome });
    this.stageDuration.observe({ stage, outcome }, durationMs / 1_000);
  }

  stateExited(state: TaskState, seconds: number): void {
    this.stateDwell.observe({ state }, Math.max(0, seconds));
  }

  leasesRecovered(reason: 'expired' | 'restart', count: number): void {
    if (count > 0) this.leasesRecoveredTotal.inc({ reason }, count);
  }

  taskParked(reason: string): void {
    this.parked.inc({ reason });
  }

  retentionRemoved(kind: string, count: number): void {
    if (count > 0) this.retentionPruned.inc({ kind }, count);
  }

  circuitEvents(provider: string): CircuitEvents {
    this.circuitState.set({ provider }, 0);
    return {
      onStateChange: (state) => this.circuitState.set({ provider }, circuitValue[state]),
      onCall: (result) => this.providerCalls.inc({ provider, result }),
    };
  }

  /** Refreshes gauges from a PostgreSQL snapshot. States without tasks report zero so alerts resolve. */
  applySnapshot(snapshot: OperationalSnapshot, pricing: Readonly<Record<string, ModelPrice>>): void {
    this.tasks.reset();
    this.stateAge.reset();
    for (const state of taskStates) {
      const row = snapshot.tasksByState.find((entry) => entry.state === state);
      this.tasks.set({ state }, row?.tasks ?? 0);
      this.stateAge.set({ state }, row?.oldestStateAgeSeconds ?? 0);
    }
    this.staleLeases.set({}, snapshot.staleLeases);
    this.manual.set({}, snapshot.manualIntervention);
    this.quarantined.set({}, snapshot.quarantined);
    this.awaitingMerge.set({}, snapshot.workUnitsAwaitingMerge);
    for (const row of snapshot.attempts) this.attempts.set({ stage: row.stage, category: row.category }, row.attempts);
    for (const row of snapshot.tokens) {
      this.tokens.set({ model: row.model, kind: 'input' }, row.inputTokens);
      this.tokens.set({ model: row.model, kind: 'cached_input' }, row.cachedInputTokens);
      this.tokens.set({ model: row.model, kind: 'output' }, row.outputTokens);
      this.tokens.set({ model: row.model, kind: 'reasoning_output' }, row.reasoningOutputTokens);
      const price = pricing[row.model];
      if (price !== undefined) this.cost.set({ model: row.model }, estimateCostUsd(row, price));
    }
  }

  applyScheduler(source: SchedulerGaugeSource): void {
    const now = this.clock().getTime();
    const delivery = new Set<TaskState>(['PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW']);
    this.inFlight.set({ lane: 'execution' }, source.inFlight.filter((entry) => !delivery.has(entry.stage)).length);
    this.inFlight.set({ lane: 'delivery' }, source.inFlight.filter((entry) => delivery.has(entry.stage)).length);
    this.inFlightAge.set({}, Math.max(0, ...source.inFlight.map((entry) => (now - entry.since.getTime()) / 1_000)));
    if (source.controls !== null) {
      this.killSwitch.set({}, source.controls.killSwitch ? 1 : 0);
      this.pauseNewWork.set({}, source.controls.pauseNewWork ? 1 : 0);
    }
    for (const lane of ['execution', 'delivery'] as const) {
      const hold = source.laneHolds[lane];
      this.laneHold.set({ lane }, hold !== undefined && hold.until.getTime() > now ? 1 : 0);
    }
  }
}

/**
 * Runner input tokens include cached input tokens, and output tokens include reasoning tokens, so cached tokens are priced
 * at the cached rate and reasoning tokens are not charged twice.
 */
export function estimateCostUsd(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }, price: ModelPrice): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * price.inputPerMillionTokens + usage.cachedInputTokens * price.cachedInputPerMillionTokens + usage.outputTokens * price.outputPerMillionTokens) / 1_000_000;
}
