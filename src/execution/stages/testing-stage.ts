import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import type { RepositoryQualityReport } from '../quality-gates.js';
import {
  checkpointKeys, completeAttempt, loadTaskWorkspaces, manualIntervention, qualityPassedSchema, readCheckpoint, restoreAll, sameHeads,
  startAttempt, type ExecutionDependencies,
} from './stage-support.js';

/**
 * `TESTING`: runs every repository's trusted setup and check commands against the committed branch. Passing gates move
 * to review. Failures request a bounded fix until `maxQualityFixAttempts`, then the task fails. The pass is recorded
 * against the exact commits it verified.
 */
export class TestingStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    const loaded = await loadTaskWorkspaces(deps, task);
    const passed = await readCheckpoint(context, checkpointKeys.qualityPassed, qualityPassedSchema);
    if (passed !== undefined && sameHeads(passed.heads, loaded.heads)) {
      return { kind: 'advance', to: 'REVIEWING', reason: 'Quality gates already passed for these commits' };
    }

    // Gates run against committed content only.
    await restoreAll(deps, loaded);
    const scope = await startAttempt(deps, task, { heads: loaded.heads });
    const reports: RepositoryQualityReport[] = [];
    for (const unit of loaded.units) {
      const report = await deps.quality.run(unit.repository, unit.workspacePath, 'all', context.signal);
      reports.push(report);
      if (report.aborted) {
        await restoreAll(deps, loaded);
        await completeAttempt(scope, { category: 'cancelled', evidence: { reports } });
        return { kind: 'interrupted' };
      }
      if (report.infrastructureError !== null) {
        await restoreAll(deps, loaded);
        await completeAttempt(scope, { category: 'quality-infrastructure', evidence: { reports } });
        return manualIntervention(`Quality gate could not run in ${unit.repository}: ${report.infrastructureError}`);
      }
    }
    // Commands may write untracked artifacts; they are never part of the change.
    const discarded = await restoreAll(deps, loaded);
    const evidence = { reports, discardedArtifacts: discarded };
    context.log('quality_gates_completed', { attempt: scope.attempt, passed: reports.every((report) => report.passed), repositories: reports.map((report) => ({ repository: report.repository, passed: report.passed })) });

    if (reports.every((report) => report.passed)) {
      await context.checkpoint(checkpointKeys.qualityPassed, { heads: loaded.heads, attempt: scope.attempt });
      await completeAttempt(scope, { category: null, evidence });
      return { kind: 'advance', to: 'REVIEWING', reason: 'Quality gates passed' };
    }

    await completeAttempt(scope, { category: 'quality-failed', evidence });
    const failures = reports.flatMap((report) => report.results.filter((result) => !result.passed).map((result) => ({
      repository: report.repository, phase: result.phase, name: result.name, command: result.command, outcome: result.outcome, exitCode: result.exitCode, outputTail: result.outputTail,
    })));
    const summary = failures.map((failure) => `${failure.repository}:${failure.name} ${failure.outcome === 'exited' ? 'failed' : failure.outcome} (exit ${failure.exitCode ?? 'none'})`).join(', ');
    const maxFixes = deps.config.limits.maxQualityFixAttempts;
    if (task.qualityFixAttempts >= maxFixes) {
      return { kind: 'advance', to: 'FAILED', reason: 'Quality fix attempts exhausted', lastError: `Quality gates still failing after ${maxFixes} fix attempts: ${summary}` };
    }
    await context.checkpoint(checkpointKeys.fixRequest, { id: `quality-${scope.attempt}`, source: 'quality', heads: loaded.heads, details: failures });
    return { kind: 'advance', to: 'FIXING', reason: `Quality gates failed: ${summary}`, incrementCounter: 'qualityFixAttempts' };
  }
}
