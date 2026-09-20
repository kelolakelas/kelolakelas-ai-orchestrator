import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import { escalationStep } from '../../routing/escalation-policy.js';
import { resolveRoute, type Effort, type ModelSelection } from '../../routing/model-router.js';
import { fixResultSchema } from '../agent-results.js';
import { buildFixPrompt, promptDigest, promptTemplateVersion } from '../prompts.js';
import { inspectAndCommit } from './change-application.js';
import {
  checkpointKeys, commitMessage, completeAttempt, failureCategoryOf, fixAppliedSchema, fixRequestSchema, loadTaskWorkspaces,
  manualIntervention, modelInput, pauseOrInterruption, plannedPaths, readCheckpoint, requireAnalysis, restoreAll, sameHeads, startAttempt,
  type ExecutionDependencies,
} from './stage-support.js';

/**
 * `FIXING`: applies a bounded fix for the latest quality-gate failure or review request, with the same Git and diff
 * checks as implementation. Every outcome returns to `TESTING`; a failed or rejected fix is simply not committed, so the
 * gates fail again and consume the next bounded attempt. This keeps every cycle finite.
 */
export class FixingStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    const loaded = await loadTaskWorkspaces(deps, task);
    const request = await readCheckpoint(context, checkpointKeys.fixRequest, fixRequestSchema);
    if (request === undefined) return manualIntervention('No fix request exists for this task');
    const applied = await readCheckpoint(context, checkpointKeys.fixApplied, fixAppliedSchema);
    if (applied?.requestId === request.id) return { kind: 'advance', to: 'TESTING', reason: `Fix ${request.id} already applied` };
    if (!sameHeads(request.heads, loaded.heads)) return manualIntervention(`Branches moved since fix ${request.id} was requested`);

    const plan = await requireAnalysis(context);
    const model = this.model(loaded.contract.complexity, task.implementationAttempts, task);
    if (model === undefined) return manualIntervention('No model route is available for a fix');

    await restoreAll(deps, loaded);
    const prompt = buildFixPrompt({ contract: loaded.contract, workspaces: loaded.prompt, plan, request: { source: request.source, details: request.details } });
    const scope = await startAttempt(deps, task, {
      promptTemplateVersion, ...promptDigest(prompt), model: modelInput(model), fixRequest: request.id, heads: loaded.heads,
    });

    const result = await deps.runner.run({
      role: 'fixer', model, prompt, taskDirectory: loaded.taskDirectory, access: 'workspace-write', resultSchema: fixResultSchema,
      timeoutMs: deps.agents.runner.timeoutMinutes.fix * 60_000, signal: context.signal,
    });
    context.log('agent_run_completed', { role: 'fixer', fixRequest: request.id, model: model.model, effort: model.effort, result: result.kind, durationMs: result.durationMs, usage: result.usage });

    const stopped = pauseOrInterruption(deps, result);
    if (stopped) {
      if (stopped.category === 'cancelled') await restoreAll(deps, loaded);
      await completeAttempt(scope, { category: stopped.category, usage: result.usage });
      return stopped.outcome;
    }
    if (result.kind !== 'completed') {
      const category = failureCategoryOf(result.kind as 'invalid-output' | 'timeout' | 'failed');
      await restoreAll(deps, loaded);
      await context.checkpoint(checkpointKeys.fixApplied, { requestId: request.id, commits: null, category });
      await completeAttempt(scope, { category, evidence: { detail: result.message }, usage: result.usage });
      return { kind: 'advance', to: 'TESTING', reason: `Fix ${request.id} not applied (${category})` };
    }
    if (result.output.status === 'blocked') {
      await restoreAll(deps, loaded);
      await completeAttempt(scope, { category: 'agent-blocked', result: result.output, usage: result.usage });
      return manualIntervention(`Fixer stopped: ${result.output.blockedReason ?? result.output.summary}`, 'Fixer needs a decision');
    }

    const identifier = loaded.contract.source?.linearIdentifier ?? task.linearIdentifier;
    const application = await inspectAndCommit(deps, loaded, {
      required: [],
      plannedPaths: plannedPaths(plan),
      message: (repository) => commitMessage(
        `${identifier}: address ${request.source === 'quality' ? 'quality gate failures' : 'review findings'}`,
        result.output.repositories.find((entry) => entry.repository === repository)?.summary ?? result.output.summary,
        { 'Orchestrator-Task': task.id, 'Orchestrator-Stage': `fix/${request.id}` },
      ),
    });
    if (application.kind === 'integrity') {
      await completeAttempt(scope, { category: 'workspace-integrity', evidence: { detail: application.detail }, usage: result.usage });
      return manualIntervention(`Workspace integrity check failed after fix: ${application.detail}`);
    }
    if (application.kind === 'rejected') {
      await context.checkpoint(checkpointKeys.fixApplied, { requestId: request.id, commits: null, category: 'diff-rejected' });
      await completeAttempt(scope, { category: 'diff-rejected', evidence: { detail: application.detail, violations: application.violations, diff: application.evidence }, usage: result.usage });
      return { kind: 'advance', to: 'TESTING', reason: `Fix ${request.id} rejected: ${application.detail}` };
    }

    await context.checkpoint(checkpointKeys.fixApplied, { requestId: request.id, commits: application.commits, category: null });
    await completeAttempt(scope, { category: null, result: result.output, evidence: { commits: application.commits, diff: application.evidence }, usage: result.usage });
    return { kind: 'advance', to: 'TESTING', reason: `Fix ${request.id} committed` };
  }

  /** Fixes use the route of the latest implementation attempt; escalation happens only through implementation retries. */
  private model(complexity: Parameters<typeof escalationStep>[1], implementationAttempts: number, task: { selectedModelTier: string | null; selectedModel: string | null; reasoningEffort: string | null }): ModelSelection | undefined {
    const { deps } = this;
    const efforts: readonly string[] = ['low', 'medium', 'high', 'max'] satisfies Effort[];
    if (task.selectedModelTier !== null && task.reasoningEffort !== null && efforts.includes(task.reasoningEffort) && deps.config.models.tiers[task.selectedModelTier] !== undefined) {
      // Tier, model, and provider are re-read from configuration, never trusted from the database row.
      return resolveRoute(deps.config, { tier: task.selectedModelTier, effort: task.reasoningEffort as Effort });
    }
    return escalationStep(deps.config, complexity, Math.max(1, implementationAttempts));
  }
}
