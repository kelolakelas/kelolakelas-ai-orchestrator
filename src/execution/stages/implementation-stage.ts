import type { StageContext, StageHandler, StageOutcome } from '../../orchestrator/stage-handler.js';
import { escalationStep } from '../../routing/escalation-policy.js';
import { implementationResultSchema } from '../agent-results.js';
import type { AgentUsage } from '../agent-runner.js';
import { buildImplementationPrompt, promptDigest, promptTemplateVersion } from '../prompts.js';
import { inspectAndCommit } from './change-application.js';
import {
  checkpointKeys, commitMessage, completeAttempt, failureCategoryOf, implementationCheckpointSchema, implementationRejectionSchema,
  loadTaskWorkspaces, manualIntervention, modelInput, pauseOrInterruption, plannedPaths, readCheckpoint, requireAnalysis, restoreAll,
  startAttempt, type AttemptScope, type ExecutionDependencies, type FailureCategory,
} from './stage-support.js';

/**
 * `IMPLEMENTING`: a write-enabled implementer changes the worktrees according to the accepted plan. The orchestrator
 * then verifies Git ownership, applies the diff policy, and commits locally. A rejected attempt is discarded and retried
 * through `READY` with the next escalation route until `maxImplementationAttempts`, then the task fails.
 */
export class ImplementationStage implements StageHandler {
  constructor(private readonly deps: ExecutionDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    const loaded = await loadTaskWorkspaces(deps, task);
    const plan = await requireAnalysis(context);

    const committed = await readCheckpoint(context, checkpointKeys.implementation, implementationCheckpointSchema);
    if (committed !== undefined) {
      for (const unit of loaded.units) {
        const commit = committed.commits[unit.repository];
        if (commit === undefined || !await deps.changes.isAncestor(unit.workspacePath, commit, unit.head)) {
          return manualIntervention(`Committed implementation for ${unit.repository} is no longer in the branch history`);
        }
      }
      return {
        kind: 'advance',
        to: 'TESTING',
        reason: 'Committed implementation reused',
        ...(task.implementationAttempts < committed.implementationAttempt ? { incrementCounter: 'implementationAttempts' as const } : {}),
      };
    }
    const unexpected = loaded.units.find((unit) => unit.head !== unit.baseCommit);
    if (unexpected) return manualIntervention(`${unexpected.repository} has commits that no accepted implementation recorded`);

    const maxAttempts = deps.config.limits.maxImplementationAttempts;
    const attempt = task.implementationAttempts + 1;
    const model = attempt <= maxAttempts ? escalationStep(deps.config, loaded.contract.complexity, attempt) : undefined;
    if (model === undefined) {
      return { kind: 'advance', to: 'FAILED', reason: 'Implementation attempts exhausted', lastError: `No implementation route remains for ${loaded.contract.complexity} complexity at attempt ${attempt}` };
    }

    // An interrupted earlier run may have left partial, unverified output.
    await restoreAll(deps, loaded);
    await deps.tasks.recordModelSelection(task.id, deps.workerId, model);
    const rejection = await readCheckpoint(context, checkpointKeys.implementationRejection, implementationRejectionSchema);
    const documentation = await deps.documentation.load(loaded.contract.repositories);
    const prompt = buildImplementationPrompt({
      contract: loaded.contract, workspaces: loaded.prompt, documentation, plan, attempt,
      previousRejection: rejection !== undefined && rejection.implementationAttempt < attempt ? `${rejection.category}: ${rejection.detail}` : null,
    });
    const scope = await startAttempt(deps, task, {
      promptTemplateVersion, ...promptDigest(prompt), model: modelInput(model), implementationAttempt: attempt, heads: loaded.heads,
      documentation: documentation.map(({ path, sha256, truncated }) => ({ path, sha256, truncated })),
    });

    const result = await deps.runner.run({
      role: 'implementer', model, prompt, taskDirectory: loaded.taskDirectory, access: 'workspace-write', resultSchema: implementationResultSchema,
      timeoutMs: deps.agents.runner.timeoutMinutes.implementation * 60_000, signal: context.signal,
    });
    context.log('agent_run_completed', { role: 'implementer', attempt, model: model.model, effort: model.effort, result: result.kind, durationMs: result.durationMs, usage: result.usage });

    const stopped = pauseOrInterruption(deps, result);
    if (stopped) {
      if (stopped.category === 'cancelled') await restoreAll(deps, loaded);
      await completeAttempt(scope, { category: stopped.category, usage: result.usage });
      return stopped.outcome;
    }
    if (result.kind !== 'completed') {
      const kind = result.kind as 'invalid-output' | 'timeout' | 'failed';
      return this.reject(context, scope, attempt, failureCategoryOf(kind), result.message, result.usage, {}, loaded);
    }
    if (result.output.status === 'blocked') {
      await restoreAll(deps, loaded);
      await completeAttempt(scope, { category: 'agent-blocked', result: result.output, usage: result.usage });
      return manualIntervention(`Implementer stopped: ${result.output.blockedReason ?? result.output.summary}`, 'Implementer needs a decision');
    }

    const identifier = loaded.contract.source?.linearIdentifier ?? task.linearIdentifier;
    const application = await inspectAndCommit(deps, loaded, {
      required: loaded.contract.repositories,
      plannedPaths: plannedPaths(plan),
      message: (repository) => commitMessage(
        `${identifier}: ${loaded.contract.title}`,
        result.output.repositories.find((entry) => entry.repository === repository)?.summary ?? result.output.summary,
        { 'Orchestrator-Task': task.id, 'Orchestrator-Stage': `implementation/${attempt}` },
      ),
    });
    if (application.kind === 'integrity') {
      await completeAttempt(scope, { category: 'workspace-integrity', evidence: { detail: application.detail }, usage: result.usage });
      return manualIntervention(`Workspace integrity check failed after implementation: ${application.detail}`);
    }
    if (application.kind === 'rejected') {
      return this.reject(context, scope, attempt, 'diff-rejected', application.detail, result.usage, { violations: application.violations, diff: application.evidence }, loaded);
    }

    await context.checkpoint(checkpointKeys.implementation, { implementationAttempt: attempt, commits: application.commits });
    await completeAttempt(scope, { category: null, result: result.output, evidence: { commits: application.commits, diff: application.evidence }, usage: result.usage });
    return { kind: 'advance', to: 'TESTING', reason: `Implementation attempt ${attempt} committed`, incrementCounter: 'implementationAttempts' };
  }

  private async reject(
    context: StageContext,
    scope: AttemptScope,
    attempt: number,
    category: FailureCategory,
    detail: string,
    usage: AgentUsage | null,
    evidence: Record<string, unknown>,
    loaded: Parameters<typeof restoreAll>[1],
  ): Promise<StageOutcome> {
    await restoreAll(this.deps, loaded);
    await context.checkpoint(checkpointKeys.implementationRejection, { implementationAttempt: attempt, category, detail });
    await completeAttempt(scope, { category, evidence: { detail, ...evidence }, usage });
    const maxAttempts = this.deps.config.limits.maxImplementationAttempts;
    if (attempt >= maxAttempts) {
      return { kind: 'advance', to: 'FAILED', reason: 'Implementation attempts exhausted', incrementCounter: 'implementationAttempts', lastError: `Implementation attempt ${attempt} of ${maxAttempts} rejected (${category}): ${detail}` };
    }
    return { kind: 'advance', to: 'READY', reason: `Implementation attempt ${attempt} rejected (${category}); retrying`, incrementCounter: 'implementationAttempts' };
  }
}
