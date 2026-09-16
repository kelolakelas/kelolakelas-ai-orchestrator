import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import type { RepositoryQualityReport } from '../quality-gates.js';
import {
  checkpointKeys, completeAttempt, loadTaskWorkspaces, manualIntervention, readCheckpoint, restoreAll, sameHeads, setupCheckpointSchema,
  startAttempt, type ExecutionDependencies,
} from './stage-support.js';

/**
 * `READY`: runs each repository's trusted setup commands (for example a dependency install) so the implementer can run
 * the repository's own tests offline, then starts implementation. Setup is skipped when it already ran for the current
 * commits. A setup failure before any agent change is an environment problem, so it stops for an operator.
 */
export class ReadyStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const loaded = await loadTaskWorkspaces(deps, context.task);
    const done = await readCheckpoint(context, checkpointKeys.setup, setupCheckpointSchema);
    const needed = loaded.units.filter((unit) => deps.quality.hasSetup(unit.repository));
    if (needed.length === 0 || (done !== undefined && sameHeads(done.heads, loaded.heads))) {
      return { kind: 'advance', to: 'IMPLEMENTING', reason: 'Workspaces ready for implementation' };
    }

    const scope = await startAttempt(deps, context.task, { phase: 'setup', heads: loaded.heads });
    const reports: RepositoryQualityReport[] = [];
    for (const unit of needed) {
      const report = await deps.quality.run(unit.repository, unit.workspacePath, 'setup', context.signal);
      reports.push(report);
      if (report.aborted) {
        await completeAttempt(scope, { category: 'cancelled', evidence: { reports } });
        return { kind: 'interrupted' };
      }
      if (!report.passed) {
        await completeAttempt(scope, { category: report.infrastructureError === null ? 'quality-failed' : 'quality-infrastructure', evidence: { reports } });
        const failed = report.results.find((result) => !result.passed);
        return manualIntervention(`Setup failed in ${unit.repository} before implementation: ${report.infrastructureError ?? `${failed?.name ?? 'command'} ${failed?.outcome ?? ''} (exit ${failed?.exitCode ?? 'none'})`}`);
      }
    }
    // Setup must not leave tracked or unignored files that would be mistaken for agent changes.
    const discarded = await restoreAll(deps, loaded);
    await context.checkpoint(checkpointKeys.setup, { heads: loaded.heads });
    await completeAttempt(scope, { category: null, evidence: { reports, discardedSetupArtifacts: discarded } });
    return { kind: 'advance', to: 'IMPLEMENTING', reason: 'Workspace setup completed' };
  }
}
