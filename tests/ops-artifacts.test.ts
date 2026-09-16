import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrchestratorMetrics } from '../src/observability/orchestrator-metrics.js';

/** Alerts and dashboards silently stop working when a metric is renamed; keep them tied to what the service exports. */
describe('operations artifacts', () => {
  it('reference only exported metrics', async () => {
    const metrics = new OrchestratorMetrics();
    metrics.circuitEvents('github');
    const exported = new Set([...(await metrics.registry.render()).matchAll(/^# TYPE (\S+) /gm)].map((match) => match[1]));
    for (const file of ['ops/prometheus/alerts.yml', 'ops/grafana/ai-orchestrator-dashboard.json']) {
      const referenced = new Set([...readFileSync(file, 'utf8').matchAll(/\borchestrator_[a-z_]+/g)].map((match) => match[0].replace(/_(bucket|sum|count)$/, '')));
      expect([...referenced].filter((name) => !exported.has(name)), file).toEqual([]);
      expect(referenced.size, file).toBeGreaterThan(5);
    }
  });

  it('link every alert to a runbook section', () => {
    const alerts = readFileSync('ops/prometheus/alerts.yml', 'utf8');
    expect(alerts.match(/- alert: /g)?.length).toBe(alerts.match(/runbook: "ai-orchestrator-operations\.md#[a-z-]+"/g)?.length);
  });
});
