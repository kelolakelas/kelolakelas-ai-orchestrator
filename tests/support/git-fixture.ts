import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, type OrchestratorConfig } from '../../src/config/schema.js';
import type { RepositoryName } from '../../src/workspaces/repository-registry.js';
import { testConfig } from './config.js';

const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface GitFixture {
  base: string;
  workspaceRoot: string;
  clone(name: RepositoryName): string;
  bare(name: RepositoryName): string;
  /** Commits a file directly to the remote base branch and returns the new commit. */
  pushRemoteCommit(name: RepositoryName, file: string): string;
  config(overrides?: { workspace?: Record<string, unknown>; prepareWorkspaces?: boolean }): OrchestratorConfig;
  cleanup(): void;
}

/**
 * Creates a bare "remote" and a local clone per repository. The clone's origin URL is the GitHub URL expected by the
 * registry, rewritten to the bare repository through `url.<path>.insteadOf`.
 */
export function createGitFixture(names: readonly RepositoryName[]): GitFixture {
  const base = mkdtempSync(join(tmpdir(), 'orchestrator-git-'));
  const workspaceRoot = join(base, 'workspaces');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');

  for (const name of names) {
    const bare = join(base, 'remotes', `${name}.git`);
    const clone = join(base, 'clones', name);
    git(base, 'clone', '-q', '--bare', seed, bare);
    git(base, 'clone', '-q', bare, clone);
    git(clone, 'remote', 'set-url', 'origin', `https://github.com/kelolakelas/kelolakelas-${name}.git`);
    git(clone, 'config', `url.${bare}.insteadOf`, `https://github.com/kelolakelas/kelolakelas-${name}.git`);
  }

  return {
    base,
    workspaceRoot,
    clone: (name) => join(base, 'clones', name),
    bare: (name) => join(base, 'remotes', `${name}.git`),
    pushRemoteCommit(name, file) {
      const scratch = join(base, `scratch-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      git(base, 'clone', '-q', join(base, 'remotes', `${name}.git`), scratch);
      writeFileSync(join(scratch, file), `${file}\n`);
      git(scratch, 'add', '.');
      git(scratch, 'commit', '-q', '-m', `add ${file}`);
      git(scratch, 'push', '-q', 'origin', 'main');
      const commit = git(scratch, 'rev-parse', 'HEAD');
      rmSync(scratch, { recursive: true, force: true });
      return commit;
    },
    config(overrides = {}) {
      const baseConfig = testConfig();
      return validateConfig({
        ...baseConfig,
        orchestrator: { ...baseConfig.orchestrator, execution: { prepareWorkspaces: overrides.prepareWorkspaces ?? true } },
        workspace: { root: workspaceRoot, minimumFreeDiskMb: 0, ...overrides.workspace },
        repositories: Object.fromEntries(names.map((name) => [name, { path: join(base, 'clones', name), github: `kelolakelas/kelolakelas-${name}` }])),
      });
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
