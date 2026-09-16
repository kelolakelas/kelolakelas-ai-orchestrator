/**
 * Minimal Prometheus text exposition (format 0.0.4). Label values must never carry task, issue, pull request, or
 * credential identifiers: metrics are served without authentication and are safe to ship to a shared monitoring system.
 */

type Labels = Record<string, string>;
type MetricType = 'counter' | 'gauge' | 'histogram';

const namePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

abstract class Metric {
  protected readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(readonly name: string, readonly help: string, readonly type: MetricType, readonly labelNames: readonly string[]) {
    if (!namePattern.test(name)) throw new Error(`Invalid metric name: ${name}`);
  }

  reset(): void {
    this.series.clear();
  }

  protected key(labels: Labels): string {
    const extra = Object.keys(labels).filter((name) => !this.labelNames.includes(name));
    if (extra.length > 0 || this.labelNames.some((name) => labels[name] === undefined)) {
      throw new Error(`Metric ${this.name} expects labels ${this.labelNames.join(', ')}`);
    }
    return this.labelNames.map((name) => labels[name]).join('\u0000');
  }

  protected static labelText(labels: Labels): string {
    const entries = Object.entries(labels);
    return entries.length === 0 ? '' : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help.replace(/\n/g, ' ')}`, `# TYPE ${this.name} ${this.type}`];
    for (const { labels, value } of this.series.values()) lines.push(`${this.name}${Metric.labelText(labels)} ${formatNumber(value)}`);
    return lines;
  }
}

export class Counter extends Metric {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, 'counter', labelNames);
  }

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) throw new Error(`Counter ${this.name} cannot decrease`);
    const key = this.key(labels);
    const current = this.series.get(key);
    this.series.set(key, { labels, value: (current?.value ?? 0) + value });
  }

  /** For counters derived from durable records, such as token usage summed in PostgreSQL. */
  set(labels: Labels, value: number): void {
    this.series.set(this.key(labels), { labels, value });
  }
}

export class Gauge extends Metric {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, 'gauge', labelNames);
  }

  set(labels: Labels, value: number): void {
    this.series.set(this.key(labels), { labels, value });
  }
}

export class Histogram extends Metric {
  private readonly buckets: readonly number[];
  private readonly observations = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]) {
    super(name, help, 'histogram', labelNames);
    this.buckets = [...buckets].sort((left, right) => left - right);
  }

  observe(labels: Labels, value: number): void {
    const key = this.key(labels);
    const entry = this.observations.get(key) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.counts[index] = (entry.counts[index] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
    this.observations.set(key, entry);
  }

  override reset(): void {
    this.observations.clear();
  }

  override render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.observations.values()) {
      this.buckets.forEach((bound, index) => {
        lines.push(`${this.name}_bucket${Metric.labelText({ ...labels, le: formatNumber(bound) })} ${counts[index] ?? 0}`);
      });
      lines.push(`${this.name}_bucket${Metric.labelText({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${Metric.labelText(labels)} ${formatNumber(sum)}`);
      lines.push(`${this.name}_count${Metric.labelText(labels)} ${count}`);
    }
    return lines;
  }
}

/** Refreshes metrics derived from external state, such as PostgreSQL, immediately before each scrape. */
export type MetricsCollector = () => Promise<void>;

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Array<{ name: string; collect: MetricsCollector }> = [];
  private readonly collectorErrors = new Gauge('orchestrator_metrics_collector_up', 'Whether the named metrics collector succeeded on the last scrape (1) or failed (0).', ['collector']);

  constructor() {
    this.metrics.set(this.collectorErrors.name, this.collectorErrors);
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.register(new Gauge(name, help, labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram {
    return this.register(new Histogram(name, help, labelNames, buckets));
  }

  addCollector(name: string, collect: MetricsCollector): void {
    this.collectors.push({ name, collect });
  }

  /** Runs collectors; a failing collector keeps its last values and reports itself down instead of failing the scrape. */
  async render(): Promise<string> {
    for (const { name, collect } of this.collectors) {
      try {
        await collect();
        this.collectorErrors.set({ collector: name }, 1);
      } catch {
        this.collectorErrors.set({ collector: name }, 0);
      }
    }
    return `${[...this.metrics.values()].flatMap((metric) => metric.render()).join('\n')}\n`;
  }

  private register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`Metric already registered: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }
}
