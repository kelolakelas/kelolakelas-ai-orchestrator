import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { estimateCostUsd, OrchestratorMetrics } from '../src/observability/orchestrator-metrics.js';

describe('metrics registry', () => {
  it('renders counters, gauges, and cumulative histogram buckets in Prometheus text format', async () => {
    const registry = new MetricsRegistry();
    registry.counter('jobs_total', 'Jobs.', ['result']).inc({ result: 'ok' }, 2);
    registry.gauge('queue_depth', 'Depth with "quotes".').set({}, 3);
    const histogram = registry.histogram('duration_seconds', 'Durations.', ['stage'], [1, 10]);
    histogram.observe({ stage: 'TESTING' }, 0.5);
    histogram.observe({ stage: 'TESTING' }, 5);
    histogram.observe({ stage: 'TESTING' }, 50);

    const text = await registry.render();
    expect(text).toContain('# TYPE jobs_total counter\njobs_total{result="ok"} 2');
    expect(text).toContain('queue_depth 3');
    expect(text).toContain('duration_seconds_bucket{stage="TESTING",le="1"} 1');
    expect(text).toContain('duration_seconds_bucket{stage="TESTING",le="10"} 2');
    expect(text).toContain('duration_seconds_bucket{stage="TESTING",le="+Inf"} 3');
    expect(text).toContain('duration_seconds_sum{stage="TESTING"} 55.5');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values and rejects unexpected labels, duplicate names, and decreasing counters', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('calls_total', 'Calls.', ['provider']);
    expect(() => counter.inc({ provider: 'github', task: 'KEL-1' })).toThrow(/expects labels/);
    expect(() => counter.inc({ provider: 'github' }, -1)).toThrow(/cannot decrease/);
    expect(() => registry.gauge('calls_total', 'Again.')).toThrow(/already registered/);
    registry.gauge('model_info', 'Model.', ['model']).set({ model: 'a"b\\c\nd' }, 1);
    return registry.render().then((text) => expect(text).toContain('model_info{model="a\\"b\\\\c\\nd"} 1'));
  });

  it('keeps serving when a collector fails and reports the collector down', async () => {
    const registry = new MetricsRegistry();
    registry.addCollector('database', async () => { throw new Error('connection refused'); });
    const text = await registry.render();
    expect(text).toContain('orchestrator_metrics_collector_up{collector="database"} 0');
    expect(text).not.toContain('connection refused');
  });
});

describe('orchestrator metrics', () => {
  it('exports state-derived gauges with zero for empty states and prices model usage', async () => {
    const metrics = new OrchestratorMetrics(() => new Date('2026-09-17T00:10:00Z'));
    metrics.applySnapshot({
      tasksByState: [{ state: 'WAITING_CI', tasks: 2, oldestStateAgeSeconds: 5_400 }],
      staleLeases: 1,
      manualIntervention: 3,
      quarantined: 0,
      attempts: [{ stage: 'TESTING', category: 'quality-failed', attempts: 4 }],
      tokens: [{ model: 'balanced-model', provider: 'primary', inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 500_000, reasoningOutputTokens: 200_000 }],
      workUnitsAwaitingMerge: 2,
    }, { 'balanced-model': { inputPerMillionTokens: 2, cachedInputPerMillionTokens: 0.5, outputPerMillionTokens: 8 } });
    metrics.applyScheduler({
      inFlight: [{ stage: 'IMPLEMENTING', since: new Date('2026-09-17T00:00:00Z') }, { stage: 'WAITING_CI', since: new Date('2026-09-17T00:09:00Z') }],
      controls: { pauseNewWork: false, killSwitch: true },
      laneHolds: { execution: { until: new Date('2026-09-17T01:00:00Z'), reason: 'runner USAGE_LIMIT' } },
    });
    metrics.stageFinished('TESTING', 'advance', 90_000);
    metrics.stateExited('WAITING_CI', 1_200);

    const text = await metrics.registry.render();
    expect(text).toContain('orchestrator_tasks{state="WAITING_CI"} 2');
    expect(text).toContain('orchestrator_tasks{state="QUEUED"} 0');
    expect(text).toContain('orchestrator_task_state_age_seconds_max{state="WAITING_CI"} 5400');
    expect(text).toContain('orchestrator_leases_stale 1');
    expect(text).toContain('orchestrator_attempts_total{stage="TESTING",category="quality-failed"} 4');
    expect(text).toContain('orchestrator_model_tokens_total{model="balanced-model",provider="primary",kind="cached_input"} 1000000');
    expect(text).toContain('orchestrator_model_cost_usd_total{model="balanced-model",provider="primary"} 6.5');
    expect(text).toContain('orchestrator_in_flight_tasks{lane="execution"} 1');
    expect(text).toContain('orchestrator_in_flight_stage_age_seconds_max 600');
    expect(text).toContain('orchestrator_kill_switch_engaged 1');
    expect(text).toContain('orchestrator_claim_lane_held{lane="execution"} 1');
    expect(text).toContain('orchestrator_claim_lane_held{lane="delivery"} 0');
    expect(text).toContain('orchestrator_state_dwell_seconds_bucket{state="WAITING_CI",le="1800"} 1');
    expect(text).not.toMatch(/KEL-|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('prices cached input at the cached rate without charging reasoning tokens twice', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, { inputPerMillionTokens: 1, cachedInputPerMillionTokens: 0.1, outputPerMillionTokens: 4 })).toBe(5);
  });
});
