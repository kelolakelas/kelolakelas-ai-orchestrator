import { existsSync } from 'node:fs';
import { mkdir, realpath, rmdir, statfs } from 'node:fs/promises';
import { GitCommandError, githubRepositoryFromUrl, parseWorktreeList, type GitRunner, type WorktreeEntry } from './git.js';
import type { RepositoryLock } from './repository-lock.js';
import { isInside, WorkspaceBlockedError, type RegisteredRepository, type RepositoryName, type RepositoryRegistry } from './repository-registry.js';

/** The remote could not be reached; preparation is safe to retry later without operator action. */
export class RemoteUnavailableError extends Error {
  constructor(repository: string, cause: unknown) {
    super(`Remote for repository ${repository} is unavailable: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    this.name = 'RemoteUnavailableError';
  }
}

export interface WorkspaceIdentity {
  repository: RepositoryName;
  workspacePath: string;
  branch: string;
  baseCommit: string;
}

export interface PrepareWorkspaceInput {
  taskId: string;
  repository: RepositoryName;
  branch: string;
  /** Identity already persisted for the work unit, if any. */
  persisted: { workspacePath: string | null; branch: string | null; baseCommit: string | null };
  signal?: AbortSignal;
}

export interface PreparedWorkspace extends WorkspaceIdentity {
  reused: boolean;
  localBaseUpdated: boolean;
}

export interface ReleaseWorkspaceInput {
  taskId: string;
  repository: RepositoryName;
  workspacePath: string;
  branch: string;
}

export type ReleaseResult = { released: true } | { released: false; reason: string };

interface OwnershipMarker {
  task: string | null;
  base: string | null;
  worktree: string | null;
}

const markerKeys = { task: 'orchestratortask', base: 'orchestratorbase', worktree: 'orchestratorworktree' } as const;

export function worktreeLockReason(taskId: string, repository: string): string {
  return `kelolakelas-ai-orchestrator task=${taskId} repository=${repository}`;
}

/**
 * Prepares and releases confined per-task Git worktrees.
 *
 * Ownership is recorded in two places that survive a crash between a Git side effect and the database write: branch
 * config markers (`branch.<name>.orchestratortask|orchestratorbase|orchestratorworktree`) and the worktree lock reason.
 * Anything that exists without matching markers is treated as user-owned or ambiguous and is never modified.
 */
export class WorkspaceManager {
  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly git: GitRunner,
    private readonly lock: RepositoryLock,
    private readonly options: { minimumFreeDiskMb: number },
  ) {}

  /** Resolves a prepared workspace path, refusing repositories the task did not declare. */
  resolveWorkspace(declaredRepositories: readonly string[], repository: string, taskId: string): string {
    if (!declaredRepositories.includes(repository)) {
      throw new WorkspaceBlockedError(`Repository ${repository} is not declared by the task contract`);
    }
    return this.registry.worktreePath(taskId, repository as RepositoryName);
  }

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    const repository = this.registry.get(input.repository);
    const workspacePath = this.registry.worktreePath(input.taskId, repository.name);
    const branch = await this.validateBranch(repository, input.branch);
    if (input.persisted.branch !== null && input.persisted.branch !== branch) {
      throw new WorkspaceBlockedError(`Persisted branch ${input.persisted.branch} differs from contract branch ${branch}`);
    }
    if (input.persisted.workspacePath !== null && input.persisted.workspacePath !== workspacePath) {
      throw new WorkspaceBlockedError(`Persisted workspace path ${input.persisted.workspacePath} differs from ${workspacePath}`);
    }

    return this.lock.withLock(repository.name, async () => {
      await this.verifyRepository(repository);
      const worktrees = await this.listWorktrees(repository);
      const worktree = worktrees.find((entry) => entry.path === workspacePath);
      const branchWorktree = worktrees.find((entry) => entry.branch === `refs/heads/${branch}`);
      const marker = await this.readMarker(repository, branch);
      const localBranchCommit = await this.revParse(repository, `refs/heads/${branch}`);
      const reason = worktreeLockReason(input.taskId, repository.name);

      if (marker.task !== null && marker.task !== input.taskId) {
        throw new WorkspaceBlockedError(`Branch ${branch} in ${repository.name} is owned by task ${marker.task}`);
      }
      if (marker.task === null && (localBranchCommit !== null || branchWorktree || worktree)) {
        throw new WorkspaceBlockedError(`Branch ${branch} or its workspace exists in ${repository.name} without orchestrator ownership`);
      }
      if (branchWorktree && branchWorktree.path !== workspacePath) {
        throw new WorkspaceBlockedError(`Branch ${branch} is checked out at ${branchWorktree.path}`);
      }

      if (worktree) {
        return { ...await this.verifyReusableWorktree(repository, worktree, input, { workspacePath, branch, marker, reason }), localBaseUpdated: false };
      }
      if (input.persisted.baseCommit !== null) {
        throw new WorkspaceBlockedError(`Persisted workspace for ${repository.name} is missing at ${workspacePath}; manual recovery required`);
      }
      if (existsSync(workspacePath)) {
        throw new WorkspaceBlockedError(`Workspace path ${workspacePath} exists but is not a registered worktree`);
      }
      if (localBranchCommit !== null && localBranchCommit !== marker.base) {
        throw new WorkspaceBlockedError(`Orchestrator branch ${branch} in ${repository.name} has commits without a workspace; manual recovery required`);
      }

      await this.ensureRemoteBranchAbsent(repository, branch, input.signal);
      const baseCommit = localBranchCommit ?? await this.fetchBase(repository, input.signal);
      const localBaseUpdated = await this.fastForwardLocalBase(repository, worktrees);
      await this.ensureDiskCapacity();

      // Markers are written before the worktree so a crash in between is recoverable rather than ambiguous.
      await this.writeMarker(repository, branch, { task: input.taskId, base: baseCommit, worktree: workspacePath });
      await mkdir(this.registry.taskDirectory(input.taskId), { recursive: true, mode: 0o750 });
      const branchArgs = localBranchCommit === null ? ['-b', branch, workspacePath, baseCommit] : [workspacePath, branch];
      await this.git.run(['worktree', 'add', '--lock', '--reason', reason, ...branchArgs], { cwd: repository.path });

      await this.verifyFreshWorktree(workspacePath, baseCommit);
      return { repository: repository.name, workspacePath, branch, baseCommit, reused: false, localBaseUpdated };
    });
  }

  /** Removes an orchestrator-owned, clean worktree. The branch and its commits are always kept. */
  async release(input: ReleaseWorkspaceInput): Promise<ReleaseResult> {
    const repository = this.registry.get(input.repository);
    const expectedPath = this.registry.worktreePath(input.taskId, repository.name);
    if (input.workspacePath !== expectedPath) return { released: false, reason: `Workspace path ${input.workspacePath} is not the orchestrator path ${expectedPath}` };

    return this.lock.withLock(repository.name, async () => {
      const worktree = (await this.listWorktrees(repository)).find((entry) => entry.path === expectedPath);
      if (!worktree) {
        return existsSync(expectedPath)
          ? { released: false, reason: `Workspace path ${expectedPath} exists but is not a registered worktree` }
          : { released: true };
      }
      const marker = await this.readMarker(repository, input.branch);
      if (marker.task !== input.taskId || worktree.lockReason !== worktreeLockReason(input.taskId, repository.name) || worktree.branch !== `refs/heads/${input.branch}`) {
        return { released: false, reason: 'Worktree ownership does not match this task' };
      }
      const status = await this.git.output(['status', '--porcelain', '--untracked-files=all'], { cwd: expectedPath });
      if (status !== '') return { released: false, reason: 'Worktree has uncommitted or untracked changes' };

      await this.git.run(['worktree', 'unlock', expectedPath], { cwd: repository.path });
      try {
        await this.git.run(['worktree', 'remove', expectedPath], { cwd: repository.path });
      } catch (error) {
        await this.git.run(['worktree', 'lock', '--reason', worktreeLockReason(input.taskId, repository.name), expectedPath], { cwd: repository.path, allowFailure: true });
        return { released: false, reason: error instanceof Error ? error.message : 'git worktree remove failed' };
      }
      try {
        await rmdir(this.registry.taskDirectory(input.taskId));
      } catch {
        // Another repository's worktree for the same task may remain.
      }
      return { released: true };
    });
  }

  private async validateBranch(repository: RegisteredRepository, branch: string): Promise<string> {
    const result = await this.git.run(['check-ref-format', '--branch', branch], { cwd: repository.path, allowFailure: true });
    const normalized = result.stdout.trim();
    if (result.exitCode !== 0 || normalized !== branch || branch === repository.baseBranch || branch.startsWith('-')) {
      throw new WorkspaceBlockedError(`Branch name ${JSON.stringify(branch)} is not a valid task branch`);
    }
    return branch;
  }

  private async verifyRepository(repository: RegisteredRepository): Promise<void> {
    const topLevel = await this.git.run(['rev-parse', '--show-toplevel'], { cwd: repository.path, allowFailure: true });
    if (topLevel.exitCode !== 0 || await realpath(topLevel.stdout.trim()).catch(() => '') !== repository.path) {
      throw new WorkspaceBlockedError(`Registered path for ${repository.name} is not the top level of a Git repository`);
    }
    // The configured URL is checked, not the `url.<base>.insteadOf` expansion, which is trusted host configuration.
    const url = await this.git.run(['config', '--local', '--get', `remote.${repository.remote}.url`], { cwd: repository.path, allowFailure: true });
    if (url.exitCode !== 0 || githubRepositoryFromUrl(url.stdout) !== repository.github) {
      throw new WorkspaceBlockedError(`Remote ${repository.remote} of ${repository.name} does not point to github.com/${repository.github}`);
    }
  }

  private async listWorktrees(repository: RegisteredRepository): Promise<WorktreeEntry[]> {
    return parseWorktreeList((await this.git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: repository.path })).stdout);
  }

  private async revParse(repository: RegisteredRepository, ref: string, cwd = repository.path): Promise<string | null> {
    const result = await this.git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private async readMarker(repository: RegisteredRepository, branch: string): Promise<OwnershipMarker> {
    const read = async (key: string) => {
      const result = await this.git.run(['config', '--local', '--get', `branch.${branch}.${key}`], { cwd: repository.path, allowFailure: true });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    };
    return { task: await read(markerKeys.task), base: await read(markerKeys.base), worktree: await read(markerKeys.worktree) };
  }

  private async writeMarker(repository: RegisteredRepository, branch: string, marker: { task: string; base: string; worktree: string }): Promise<void> {
    for (const [field, key] of Object.entries(markerKeys) as Array<[keyof typeof markerKeys, string]>) {
      await this.git.run(['config', '--local', `branch.${branch}.${key}`, marker[field]], { cwd: repository.path });
    }
  }

  private async verifyReusableWorktree(
    repository: RegisteredRepository,
    worktree: WorktreeEntry,
    input: PrepareWorkspaceInput,
    expected: { workspacePath: string; branch: string; marker: OwnershipMarker; reason: string },
  ): Promise<Omit<PreparedWorkspace, 'localBaseUpdated'>> {
    const { marker } = expected;
    if (worktree.branch !== `refs/heads/${expected.branch}` || worktree.lockReason !== expected.reason) {
      throw new WorkspaceBlockedError(`Worktree ${expected.workspacePath} is not locked by the orchestrator for branch ${expected.branch}`);
    }
    if (marker.base === null || marker.worktree !== expected.workspacePath) {
      throw new WorkspaceBlockedError(`Ownership markers for ${expected.branch} in ${repository.name} are incomplete`);
    }
    if (input.persisted.baseCommit !== null && input.persisted.baseCommit !== marker.base) {
      throw new WorkspaceBlockedError(`Persisted base commit differs from the worktree base in ${repository.name}`);
    }
    const head = await this.revParse(repository, 'HEAD', expected.workspacePath);
    const ancestor = head === null
      ? { exitCode: 1 }
      : await this.git.run(['merge-base', '--is-ancestor', marker.base, head], { cwd: expected.workspacePath, allowFailure: true });
    if (ancestor.exitCode !== 0) {
      throw new WorkspaceBlockedError(`Worktree HEAD in ${repository.name} no longer descends from base ${marker.base}`);
    }
    return { repository: repository.name, workspacePath: expected.workspacePath, branch: expected.branch, baseCommit: marker.base, reused: true };
  }

  private async ensureRemoteBranchAbsent(repository: RegisteredRepository, branch: string, signal: AbortSignal | undefined): Promise<void> {
    let output: string;
    try {
      output = await this.git.output(['ls-remote', '--heads', repository.remote, `refs/heads/${branch}`], { cwd: repository.path, ...(signal ? { signal } : {}) });
    } catch (error) {
      throw new RemoteUnavailableError(repository.name, error);
    }
    if (output !== '') throw new WorkspaceBlockedError(`Branch ${branch} already exists on ${repository.remote} for ${repository.name}`);
  }

  private async fetchBase(repository: RegisteredRepository, signal: AbortSignal | undefined): Promise<string> {
    const remoteRef = `refs/remotes/${repository.remote}/${repository.baseBranch}`;
    try {
      await this.git.run(['fetch', '--no-tags', repository.remote, `+refs/heads/${repository.baseBranch}:${remoteRef}`], { cwd: repository.path, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode !== null && /couldn't find remote ref/i.test(error.message)) {
        throw new WorkspaceBlockedError(`Base branch ${repository.baseBranch} does not exist on ${repository.remote} for ${repository.name}`);
      }
      throw new RemoteUnavailableError(repository.name, error);
    }
    const base = await this.revParse(repository, remoteRef);
    if (base === null) throw new WorkspaceBlockedError(`Fetched base ${remoteRef} is missing in ${repository.name}`);
    return base;
  }

  /**
   * Best-effort fast-forward of the local base branch. It never rewrites history and never touches a checkout with
   * tracked changes; task worktrees are based on the fetched remote commit regardless.
   */
  private async fastForwardLocalBase(repository: RegisteredRepository, worktrees: readonly WorktreeEntry[]): Promise<boolean> {
    const localRef = `refs/heads/${repository.baseBranch}`;
    const remoteRef = `refs/remotes/${repository.remote}/${repository.baseBranch}`;
    const local = await this.revParse(repository, localRef);
    const remote = await this.revParse(repository, remoteRef);
    if (local === null || remote === null) return false;
    if (local === remote) return true;
    const ancestor = await this.git.run(['merge-base', '--is-ancestor', local, remote], { cwd: repository.path, allowFailure: true });
    if (ancestor.exitCode !== 0) return false;

    const checkout = worktrees.find((entry) => entry.branch === localRef);
    if (!checkout) {
      await this.git.run(['update-ref', localRef, remote, local], { cwd: repository.path });
      return true;
    }
    const status = await this.git.output(['status', '--porcelain', '--untracked-files=no'], { cwd: checkout.path });
    if (status !== '') return false;
    const merged = await this.git.run(['merge', '--ff-only', remoteRef], { cwd: checkout.path, allowFailure: true });
    return merged.exitCode === 0;
  }

  private async ensureDiskCapacity(): Promise<void> {
    const stats = await statfs(this.registry.workspaceRoot);
    const freeMb = (stats.bavail * stats.bsize) / (1024 * 1024);
    if (freeMb < this.options.minimumFreeDiskMb) {
      throw new WorkspaceBlockedError(`Workspace root has ${Math.floor(freeMb)} MB free; ${this.options.minimumFreeDiskMb} MB required`);
    }
  }

  private async verifyFreshWorktree(workspacePath: string, baseCommit: string): Promise<void> {
    const canonical = await realpath(workspacePath);
    if (canonical !== workspacePath || !isInside(this.registry.workspaceRoot, canonical)) {
      throw new WorkspaceBlockedError(`Created worktree resolved outside the workspace root: ${canonical}`);
    }
    const head = await this.git.output(['rev-parse', 'HEAD'], { cwd: workspacePath });
    const status = await this.git.output(['status', '--porcelain', '--untracked-files=all'], { cwd: workspacePath });
    if (head !== baseCommit || status !== '') {
      throw new WorkspaceBlockedError(`Created worktree ${workspacePath} is not a clean checkout of ${baseCommit}`);
    }
  }
}
