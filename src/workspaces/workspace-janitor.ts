import type { TaskRepository } from '../repositories/task.repository.js';
import type { RepositoryName } from './repository-registry.js';
import type { WorkspaceManager } from './workspace-manager.js';

/**
 * Releases workspaces of `COMPLETED` and `CANCELLED` tasks. Worktrees that are dirty, missing ownership markers, or
 * otherwise ambiguous are kept, and the reason is recorded on the work unit; the sweep retries them on later ticks.
 */
export class WorkspaceJanitor {
  readonly name = 'workspace-janitor';

  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly tasks: TaskRepository,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
  ) {}

  async run(): Promise<void> {
    for (const unit of await this.tasks.listWorkspacesPendingRelease()) {
      const fields = { taskId: unit.taskId, repository: unit.repository, workspacePath: unit.workspacePath };
      try {
        const result = await this.workspaces.release({
          taskId: unit.taskId,
          repository: unit.repository as RepositoryName,
          workspacePath: unit.workspacePath,
          branch: unit.branch,
        });
        if (result.released) {
          await this.tasks.markWorkspaceReleased(unit.id, null);
          this.log('workspace_released', fields);
        } else if (unit.workspaceCleanupBlockedReason !== result.reason) {
          await this.tasks.markWorkspaceReleased(unit.id, result.reason);
          this.log('workspace_release_blocked', { ...fields, reason: result.reason });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown error';
        if (unit.workspaceCleanupBlockedReason !== reason) await this.tasks.markWorkspaceReleased(unit.id, reason);
        this.log('workspace_release_failed', { ...fields, reason });
      }
    }
  }
}
