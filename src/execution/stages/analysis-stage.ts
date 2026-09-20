import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import { analysisProblems, analysisResultSchema } from '../agent-results.js';
import { buildAnalysisPrompt, promptDigest, promptTemplateVersion } from '../prompts.js';
import {
  analysisCheckpointSchema, checkpointKeys, completeAttempt, contractDigest, failureCategoryOf, loadTaskWorkspaces, manualIntervention,
  modelInput, pauseOrInterruption, readCheckpoint, roleModel, startAttempt, workspaceSnapshots, type ExecutionDependencies,
} from './stage-support.js';

/**
 * Second part of `ANALYZING`, after workspace preparation: a read-only analyzer produces a structured plan. An accepted
 * plan is checkpointed and reused, so a retried task does not analyze again. Unclear or malformed plans stop for an
 * operator rather than advancing.
 */
export class AnalysisStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    const loaded = await loadTaskWorkspaces(deps, task);
    const digest = contractDigest(task);
    const accepted = await readCheckpoint(context, checkpointKeys.analysis, analysisCheckpointSchema);
    if (accepted?.contractDigest === digest) return { kind: 'advance', to: 'READY', reason: 'Accepted analysis reused' };

    const documentation = await deps.documentation.load(loaded.contract.repositories);
    const prompt = buildAnalysisPrompt({ contract: loaded.contract, workspaces: loaded.prompt, documentation });
    const model = roleModel(deps.config, 'analyzer');
    const scope = await startAttempt(deps, task, {
      promptTemplateVersion, ...promptDigest(prompt), model: modelInput(model), heads: loaded.heads, contractDigest: digest,
      documentation: documentation.map(({ path, sha256, truncated }) => ({ path, sha256, truncated })),
    });

    const before = await workspaceSnapshots(deps, loaded);
    const result = await deps.runner.run({
      role: 'analyzer', model, prompt, taskDirectory: loaded.taskDirectory, access: 'read-only', resultSchema: analysisResultSchema,
      timeoutMs: deps.agents.runner.timeoutMinutes.analysis * 60_000, signal: context.signal,
    });
    context.log('agent_run_completed', { role: 'analyzer', result: result.kind, durationMs: result.durationMs, usage: result.usage });

    if (await workspaceSnapshots(deps, loaded) !== before) {
      await completeAttempt(scope, { category: 'workspace-integrity', usage: result.usage });
      return manualIntervention('The read-only analyzer changed a workspace; inspect the worktrees before retrying');
    }
    const stopped = pauseOrInterruption(deps, result);
    if (stopped) {
      await completeAttempt(scope, { category: stopped.category, usage: result.usage });
      return stopped.outcome;
    }
    if (result.kind !== 'completed') {
      const kind = result.kind as 'invalid-output' | 'timeout' | 'failed';
      await completeAttempt(scope, { category: failureCategoryOf(kind), evidence: { message: result.message }, usage: result.usage });
      return manualIntervention(`Analysis ${kind}: ${result.message}`);
    }

    const problems = analysisProblems(result.output, loaded.contract.repositories);
    if (problems.length > 0) {
      await completeAttempt(scope, { category: 'invalid-output', evidence: { problems }, usage: result.usage });
      return manualIntervention(`Analysis plan rejected: ${problems.join('; ')}`);
    }
    if (result.output.decision === 'needs-clarification') {
      await completeAttempt(scope, { category: 'needs-clarification', result: result.output, usage: result.usage });
      return manualIntervention(`Analysis needs clarification: ${result.output.clarifications.join(' | ')}`, 'Contract needs clarification');
    }

    await context.checkpoint(checkpointKeys.analysis, { contractDigest: digest, attempt: scope.attempt, plan: result.output });
    await completeAttempt(scope, { category: null, result: result.output, usage: result.usage });
    return { kind: 'advance', to: 'READY', reason: 'Analysis plan accepted' };
  }
}
