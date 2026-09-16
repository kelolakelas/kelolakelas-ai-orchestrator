import type { StageContext, StageHandler, StageOutcome } from '../orchestrator/stage-handler.js';
import { validatePlanningIssue } from '../intake/planning-contract.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import { WorkspaceBlockedError, type RepositoryName } from './repository-registry.js';
import { RemoteUnavailableError, type WorkspaceManager } from './workspace-manager.js';

export const workspacesPreparedCheckpoint = 'workspaces-prepared';

/**
 * First part of `ANALYZING`: prepares one isolated worktree per repository declared by the validated contract and
 * persists each identity before continuing. Without a following stage (the Phase 5 analyzer), the task is parked in
 * `BLOCKED` so an operator can retry once analysis is available; a retry reuses the same worktrees.
 */
export class WorkspacePreparationStage implements StageHandler {
  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly tasks: TaskRepository,
    private readonly options: { workerId: string; remoteRetryMs: number; clock?: () => Date; next?: StageHandler },
  ) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { task } = context;
    const contract = validatePlanningIssue(task.contractSnapshot);
    if (!contract.source) throw new WorkspaceBlockedError('Task contract has no hydrated Linear source');

    // Defensive re-check under the lease. Stacked PRs are not expressible in the planning contract, so an unmerged
    // dependency always blocks.
    const blockers = await this.tasks.listUnfinishedBlockers(task.id);
    if (blockers.length > 0) {
      throw new WorkspaceBlockedError(`Task depends on unmerged work: ${blockers.map((blocker) => `${blocker.linearIdentifier} (${blocker.state})`).join(', ')}`);
    }

    const units = await this.tasks.getWorkUnits(task.id);
    const declared = [...contract.repositories].sort();
    const persisted = units.map((unit) => unit.repository).sort();
    if (declared.join('\0') !== persisted.join('\0')) {
      throw new WorkspaceBlockedError(`Work units [${persisted.join(', ')}] do not match contract repositories [${declared.join(', ')}]`);
    }

    const prepared = [];
    for (const unit of units) {
      if (context.signal.aborted) return { kind: 'interrupted' };
      try {
        const workspace = await this.workspaces.prepare({
          taskId: task.id,
          repository: unit.repository as RepositoryName,
          branch: contract.source.gitBranchName,
          persisted: { workspacePath: unit.workspacePath, branch: unit.branch, baseCommit: unit.baseCommit },
          signal: context.signal,
        });
        await this.tasks.recordWorkUnitWorkspace(task.id, this.options.workerId, workspace);
        context.log(workspace.reused ? 'workspace_reused' : 'workspace_prepared', {
          repository: workspace.repository, branch: workspace.branch, baseCommit: workspace.baseCommit, localBaseUpdated: workspace.localBaseUpdated,
        });
        prepared.push({ repository: workspace.repository, workspacePath: workspace.workspacePath, branch: workspace.branch, baseCommit: workspace.baseCommit });
      } catch (error) {
        if (error instanceof RemoteUnavailableError) {
          context.log('workspace_remote_unavailable', { repository: unit.repository, error: error.message });
          const now = this.options.clock?.() ?? new Date();
          return { kind: 'pause-limit', pauseReason: 'REMOTE_UNAVAILABLE', resumeAfter: new Date(now.getTime() + this.options.remoteRetryMs), reason: error.message };
        }
        throw error;
      }
    }

    await context.checkpoint(workspacesPreparedCheckpoint, { repositories: prepared });
    if (this.options.next) return this.options.next.run(context);
    return { kind: 'advance', to: 'BLOCKED', reason: 'Workspaces prepared; no analyzer stage is registered' };
  }
}
