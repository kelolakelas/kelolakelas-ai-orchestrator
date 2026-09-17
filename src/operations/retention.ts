import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RetentionConfig } from '../config/schema.js';
import type { MaintenanceTask } from '../orchestrator/scheduler.js';
import type { RetentionRepository } from '../repositories/retention.repository.js';

const dayMs = 24 * 60 * 60 * 1_000;

export interface RetentionOptions {
  config: RetentionConfig;
  repository: RetentionRepository;
  /** Directory holding per-run runner scratch directories, when agents are enabled. */
  runnerScratchRoot?: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  onRemoved?: (kind: string, count: number) => void;
  clock?: () => Date;
}

/** Applies artifact retention at most once per `intervalMinutes`. */
export class RetentionMaintenance implements MaintenanceTask {
  readonly name = 'retention';
  private lastRunAt: number | undefined;

  constructor(private readonly options: RetentionOptions) {}

  async run(): Promise<void> {
    const { config } = this.options;
    const now = (this.options.clock ?? (() => new Date()))();
    if (!config.enabled) return;
    if (this.lastRunAt !== undefined && now.getTime() - this.lastRunAt < config.intervalMinutes * 60_000) return;
    this.lastRunAt = now.getTime();

    const pruned = await this.options.repository.prune({
      terminalBefore: new Date(now.getTime() - config.terminalTaskArtifactDays * dayMs),
      quarantineBefore: new Date(now.getTime() - config.quarantineDays * dayMs),
    });
    const scratch = await this.removeRunnerScratch(now);
    const removed = { ...pruned, runnerScratch: scratch };
    for (const [kind, count] of Object.entries(removed)) this.options.onRemoved?.(kind, count);
    if (Object.values(removed).some((count) => count > 0)) this.options.log('retention_applied', removed);
  }

  /** Runner scratch directories are removed by the runner itself; this sweeps ones left behind by a crash. */
  private async removeRunnerScratch(now: Date): Promise<number> {
    const root = this.options.runnerScratchRoot;
    if (root === undefined) return 0;
    const cutoff = now.getTime() - this.options.config.runnerScratchHours * 60 * 60 * 1_000;
    let removed = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const path = join(root, name);
      const entry = await stat(path).catch(() => undefined);
      if (entry?.isDirectory() && entry.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
