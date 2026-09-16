import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import { effectiveVerdict, reviewProblems, reviewResultSchema } from '../agent-results.js';
import { buildReviewPrompt, promptDigest, promptTemplateVersion } from '../prompts.js';
import {
  checkpointKeys, completeAttempt, failureCategoryOf, loadTaskWorkspaces, manualIntervention, modelInput, pauseOrInterruption,
  qualityPassedSchema, readCheckpoint, requireAnalysis, reviewApprovedSchema, sameHeads, startAttempt, workspaceSnapshots,
  type ExecutionDependencies,
} from './stage-support.js';

/** Where an approved task waits when delivery is disabled. */
export const reviewedLocalBranchReason = 'Reviewed local branch ready; delivery is not enabled';
export const reviewAcceptedReason = 'Review accepted; delivering pull requests';

/**
 * `REVIEWING`: a read-only reviewer inspects the committed diff that passed the quality gates. Requested changes start a
 * bounded fix cycle until `maxReviewCycles`. An approval is recorded against the reviewed commits. With delivery enabled
 * the task moves to `PR_CREATED`; otherwise it parks in `BLOCKED` without manual intervention.
 */
export class ReviewStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies, private readonly options: { deliver: boolean } = { deliver: false }) {}

  private accepted(): StageOutcome {
    return this.options.deliver
      ? { kind: 'advance', to: 'PR_CREATED', reason: reviewAcceptedReason }
      : { kind: 'advance', to: 'BLOCKED', reason: reviewedLocalBranchReason };
  }

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    const loaded = await loadTaskWorkspaces(deps, task);
    const approved = await readCheckpoint(context, checkpointKeys.reviewApproved, reviewApprovedSchema);
    if (approved !== undefined && sameHeads(approved.heads, loaded.heads)) return this.accepted();
    const passed = await readCheckpoint(context, checkpointKeys.qualityPassed, qualityPassedSchema);
    if (passed === undefined || !sameHeads(passed.heads, loaded.heads)) {
      return manualIntervention('Review requires passing quality gates for the current commits');
    }

    const plan = await requireAnalysis(context);
    const diffs = [];
    for (const unit of loaded.units) {
      diffs.push({ repository: unit.repository, ...await deps.changes.diffFromBase(unit.workspacePath, unit.baseCommit, deps.agents.maxReviewDiffBytes) });
    }
    const prompt = buildReviewPrompt({ contract: loaded.contract, workspaces: loaded.prompt, plan, diffs });
    const tier = deps.config.models.reviewer.tier;
    const model = { tier, model: deps.config.models.tiers[tier]?.model ?? '', effort: deps.config.models.reviewer.effort };
    const scope = await startAttempt(deps, task, {
      promptTemplateVersion, ...promptDigest(prompt), model: modelInput(model), heads: loaded.heads,
      diffs: diffs.map(({ repository, truncated }) => ({ repository, truncated })),
    });

    const before = await workspaceSnapshots(deps, loaded);
    const result = await deps.runner.run({
      role: 'reviewer', model, prompt, taskDirectory: loaded.taskDirectory, access: 'read-only', resultSchema: reviewResultSchema,
      timeoutMs: deps.agents.runner.timeoutMinutes.review * 60_000, signal: context.signal,
    });
    context.log('agent_run_completed', { role: 'reviewer', result: result.kind, durationMs: result.durationMs, usage: result.usage });

    if (await workspaceSnapshots(deps, loaded) !== before) {
      await completeAttempt(scope, { category: 'workspace-integrity', usage: result.usage });
      return manualIntervention('The read-only reviewer changed a workspace; inspect the worktrees before retrying');
    }
    const stopped = pauseOrInterruption(deps, result);
    if (stopped) {
      await completeAttempt(scope, { category: stopped.category, usage: result.usage });
      return stopped.outcome;
    }
    if (result.kind !== 'completed') {
      const kind = result.kind as 'invalid-output' | 'timeout' | 'failed';
      await completeAttempt(scope, { category: failureCategoryOf(kind), evidence: { message: result.message }, usage: result.usage });
      return manualIntervention(`Review ${kind}: ${result.message}`);
    }
    const problems = reviewProblems(result.output, loaded.contract.repositories);
    if (problems.length > 0) {
      await completeAttempt(scope, { category: 'invalid-output', evidence: { problems }, usage: result.usage });
      return manualIntervention(`Review result rejected: ${problems.join('; ')}`);
    }

    const verdict = effectiveVerdict(result.output);
    const evidence = { declaredVerdict: result.output.verdict, verdict };
    if (verdict === 'approve') {
      await context.checkpoint(checkpointKeys.reviewApproved, { heads: loaded.heads, attempt: scope.attempt, summary: result.output.summary });
      await completeAttempt(scope, { category: null, result: result.output, evidence, usage: result.usage });
      return this.accepted();
    }
    if (verdict === 'reject') {
      await completeAttempt(scope, { category: 'review-rejected', result: result.output, evidence, usage: result.usage });
      return manualIntervention(`Reviewer rejected the change: ${result.output.summary}`, 'Review rejected');
    }

    await completeAttempt(scope, { category: 'review-changes-requested', result: result.output, evidence, usage: result.usage });
    const maxCycles = deps.config.limits.maxReviewCycles;
    if (task.reviewAttempts >= maxCycles) {
      return { kind: 'advance', to: 'FAILED', reason: 'Review cycles exhausted', lastError: `Reviewer still requests changes after ${maxCycles} review cycles: ${result.output.summary}` };
    }
    await context.checkpoint(checkpointKeys.fixRequest, { id: `review-${scope.attempt}`, source: 'review', heads: loaded.heads, details: { summary: result.output.summary, findings: result.output.findings } });
    return { kind: 'advance', to: 'FIXING', reason: `Reviewer requested changes: ${result.output.summary.slice(0, 300)}`, incrementCounter: 'reviewAttempts' };
  }
}
