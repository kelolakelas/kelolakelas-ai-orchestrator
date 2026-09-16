import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { OrchestratorConfig } from '../config/schema.js';
import type { repositoryNames } from '../intake/planning-contract.js';

export type RepositoryName = (typeof repositoryNames)[number];

export interface RegisteredRepository {
  name: RepositoryName;
  /** Canonical absolute path of the local clone. */
  path: string;
  github: string;
  remote: string;
  baseBranch: string;
}

const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rejected workspace request that needs an operator; the message is safe to persist and show. */
export class WorkspaceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBlockedError';
  }
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

/**
 * Trusted mapping from contract repository names to canonical local clones. Only repositories in this registry, and
 * only paths under the workspace root, can be opened by workspace operations.
 */
export class RepositoryRegistry {
  private constructor(
    public readonly workspaceRoot: string,
    private readonly repositories: ReadonlyMap<RepositoryName, RegisteredRepository>,
  ) {}

  static async load(config: OrchestratorConfig): Promise<RepositoryRegistry> {
    if (config.workspace === undefined) throw new Error('workspace configuration is required');
    await mkdir(config.workspace.root, { recursive: true, mode: 0o750 });
    const workspaceRoot = await realpath(config.workspace.root);
    const repositories = new Map<RepositoryName, RegisteredRepository>();

    for (const [name, entry] of Object.entries(config.repositories) as Array<[RepositoryName, NonNullable<OrchestratorConfig['repositories'][RepositoryName]>]>) {
      let path: string;
      try {
        path = await realpath(entry.path);
      } catch {
        throw new Error(`Repository ${name} path does not exist: ${entry.path}`);
      }
      if (!(await stat(path)).isDirectory()) throw new Error(`Repository ${name} path is not a directory: ${entry.path}`);
      if (path === workspaceRoot || isInside(path, workspaceRoot) || isInside(workspaceRoot, path)) {
        throw new Error(`Repository ${name} path must not overlap the workspace root`);
      }
      for (const other of repositories.values()) {
        if (other.path === path || isInside(other.path, path) || isInside(path, other.path)) {
          throw new Error(`Repository ${name} path overlaps repository ${other.name}`);
        }
      }
      repositories.set(name, { name, path, github: entry.github.toLowerCase(), remote: entry.remote, baseBranch: entry.baseBranch });
    }
    return new RepositoryRegistry(workspaceRoot, repositories);
  }

  names(): RepositoryName[] {
    return [...this.repositories.keys()];
  }

  get(name: string): RegisteredRepository {
    const repository = this.repositories.get(name as RepositoryName);
    if (!repository) throw new WorkspaceBlockedError(`Repository ${name} is not in the repository registry`);
    return repository;
  }

  /** Deterministic worktree path for one task and repository, confined to the workspace root. */
  worktreePath(taskId: string, repository: RepositoryName): string {
    if (!taskIdPattern.test(taskId)) throw new WorkspaceBlockedError(`Invalid task id for workspace path: ${taskId}`);
    this.get(repository);
    const path = join(this.workspaceRoot, taskId, repository);
    if (!isInside(this.workspaceRoot, path)) throw new WorkspaceBlockedError('Workspace path escapes the workspace root');
    return path;
  }

  taskDirectory(taskId: string): string {
    if (!taskIdPattern.test(taskId)) throw new WorkspaceBlockedError(`Invalid task id for workspace path: ${taskId}`);
    return join(this.workspaceRoot, taskId);
  }
}
