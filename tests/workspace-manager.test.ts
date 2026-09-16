import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { gitEnvironment, GitRunner, githubRepositoryFromUrl, parseWorktreeList } from '../src/workspaces/git.js';
import { InProcessRepositoryLock } from '../src/workspaces/repository-lock.js';
import { RepositoryRegistry, WorkspaceBlockedError } from '../src/workspaces/repository-registry.js';
import { RemoteUnavailableError, WorkspaceManager, worktreeLockReason } from '../src/workspaces/workspace-manager.js';
import { createGitFixture, git, type GitFixture } from './support/git-fixture.js';

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const branch = 'feature/kel-1-prepare-workspace';
const noPersisted = { workspacePath: null, branch: null, baseCommit: null };
const fixtures: GitFixture[] = [];

async function setup(overrides: Parameters<GitFixture['config']>[0] = {}) {
  const fixture = createGitFixture(['web', 'academic']);
  fixtures.push(fixture);
  const registry = await RepositoryRegistry.load(fixture.config(overrides));
  const config = fixture.config(overrides);
  const manager = new WorkspaceManager(registry, new GitRunner(30_000), new InProcessRepositoryLock(), { minimumFreeDiskMb: config.workspace?.minimumFreeDiskMb ?? 0 });
  return { fixture, registry, manager };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('git helpers', () => {
  it('withholds credentials and unrelated variables from the Git environment', () => {
    const environment = gitEnvironment({ PATH: '/usr/bin', HOME: '/home/worker', LINEAR_API_KEY: 'secret', DATABASE_URL: 'postgres://secret', ORCHESTRATOR_OPERATOR_TOKEN: 'secret' });
    expect(environment).toEqual({ PATH: '/usr/bin', HOME: '/home/worker', LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  });

  it('normalizes GitHub remotes and parses porcelain worktree lists', () => {
    expect(githubRepositoryFromUrl('git@github.com:KelolaKelas/kelolakelas-web.git')).toBe('kelolakelas/kelolakelas-web');
    expect(githubRepositoryFromUrl('https://github.com/kelolakelas/kelolakelas-web')).toBe('kelolakelas/kelolakelas-web');
    expect(githubRepositoryFromUrl('https://gitlab.com/kelolakelas/kelolakelas-web.git')).toBeUndefined();
    expect(parseWorktreeList('worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0branch refs/heads/x\0locked owner reason\0\0')).toEqual([
      { path: '/repo', head: 'abc', branch: 'refs/heads/main', locked: false, lockReason: null },
      { path: '/w', head: 'def', branch: 'refs/heads/x', locked: true, lockReason: 'owner reason' },
    ]);
  });
});

describe('repository registry', () => {
  it('requires workspace settings when preparation is enabled', () => {
    const fixture = createGitFixture(['web']);
    fixtures.push(fixture);
    const config = fixture.config();
    expect(() => validateConfig({ ...config, workspace: undefined })).toThrow(/workspace/);
    expect(() => validateConfig({ ...config, repositories: {} })).toThrow(/at least one repository/);
    expect(() => validateConfig({ ...config, repositories: { unknown: { path: '/tmp', github: 'a/b' } } })).toThrow();
    expect(() => validateConfig({ ...config, repositories: { web: { path: 'relative', github: 'a/b' } } })).toThrow(/absolute/);
  });

  it('rejects overlapping repository and workspace paths and confines workspace paths', async () => {
    const { fixture, registry } = await setup();
    const config = fixture.config();
    await expect(RepositoryRegistry.load({ ...config, workspace: { ...config.workspace!, root: join(fixture.clone('web'), 'workspaces') } })).rejects.toThrow(/overlap the workspace root/);
    await expect(RepositoryRegistry.load({ ...config, repositories: { ...config.repositories, academic: { ...config.repositories.web! } } })).rejects.toThrow(/overlaps repository/);
    expect(() => registry.worktreePath('../../etc', 'web')).toThrow(WorkspaceBlockedError);
    expect(() => registry.get('billing')).toThrow(/not in the repository registry/);
    expect(registry.worktreePath(taskA, 'web')).toBe(join(registry.workspaceRoot, taskA, 'web'));
  });
});

// Real Git subprocesses: allow for slow disks rather than the 5 second default.
describe('workspace manager', { timeout: 30_000 }, () => {
  it('creates a locked, clean worktree from the current remote base and fast-forwards local main', async () => {
    const { fixture, manager, registry } = await setup();
    const remoteHead = fixture.pushRemoteCommit('web', 'remote-change.txt');
    expect(git(fixture.clone('web'), 'rev-parse', 'main')).not.toBe(remoteHead);

    const prepared = await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    const path = join(registry.workspaceRoot, taskA, 'web');
    expect(prepared).toEqual({ repository: 'web', workspacePath: path, branch, baseCommit: remoteHead, reused: false, localBaseUpdated: true });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(fixture.clone('web'), 'rev-parse', 'main')).toBe(remoteHead);
    expect(git(fixture.clone('web'), 'config', `branch.${branch}.orchestratortask`)).toBe(taskA);
    expect(git(fixture.clone('web'), 'worktree', 'list', '--porcelain')).toContain(`locked ${worktreeLockReason(taskA, 'web')}`);
    expect(existsSync(join(registry.workspaceRoot, taskA, 'academic'))).toBe(false);
  });

  it('reuses a valid worktree after restart without moving its base, including one not yet persisted', async () => {
    const { fixture, manager } = await setup();
    const first = await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    writeFileSync(join(first.workspacePath, 'work.txt'), 'in progress\n');
    git(first.workspacePath, 'add', '.');
    git(first.workspacePath, 'commit', '-q', '-m', 'work');
    fixture.pushRemoteCommit('web', 'later.txt');

    const persisted = { workspacePath: first.workspacePath, branch, baseCommit: first.baseCommit };
    expect(await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted })).toMatchObject({ reused: true, baseCommit: first.baseCommit });
    // Crash between the Git side effect and the database write: markers and lock prove ownership.
    expect(await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).toMatchObject({ reused: true, baseCommit: first.baseCommit });
  });

  it('blocks for manual recovery when the persisted identity is ambiguous', async () => {
    const { fixture, manager } = await setup();
    const first = await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    const persisted = { workspacePath: first.workspacePath, branch, baseCommit: first.baseCommit };

    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: { ...persisted, baseCommit: 'f'.repeat(40) } })).rejects.toThrow(/differs from the worktree base/);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch: 'other-branch', persisted })).rejects.toThrow(/differs from contract branch/);

    // History rewritten so HEAD no longer descends from the recorded base.
    git(first.workspacePath, 'checkout', '-q', '--orphan', 'tmp');
    git(first.workspacePath, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    git(first.workspacePath, 'branch', '-f', branch, 'HEAD');
    git(first.workspacePath, 'checkout', '-q', branch);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted })).rejects.toThrow(/no longer descends/);

    git(fixture.clone('web'), 'worktree', 'unlock', first.workspacePath);
    git(fixture.clone('web'), 'worktree', 'remove', '--force', first.workspacePath);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted })).rejects.toThrow(/missing at/);
  });

  it('never adopts user-owned branches, paths, or another task\'s branch', async () => {
    const { fixture, manager, registry } = await setup();
    git(fixture.clone('web'), 'branch', branch);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(/without orchestrator ownership/);
    git(fixture.clone('web'), 'branch', '-D', branch);

    mkdirSync(join(registry.workspaceRoot, taskA, 'web'), { recursive: true });
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(/not a registered worktree/);
    rmSync(join(registry.workspaceRoot, taskA), { recursive: true });

    await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    await expect(manager.prepare({ taskId: taskB, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(`owned by task ${taskA}`);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch: 'main', persisted: noPersisted })).rejects.toThrow(/not a valid task branch/);
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch: 'bad..name', persisted: noPersisted })).rejects.toThrow(/not a valid task branch/);
    await expect(manager.prepare({ taskId: taskA, repository: 'billing', branch, persisted: noPersisted })).rejects.toThrow(/not in the repository registry/);
    expect(() => manager.resolveWorkspace(['web'], 'academic', taskA)).toThrow(/not declared by the task contract/);
  });

  it('blocks when the branch already exists remotely or the remote URL is unexpected', async () => {
    const { fixture, manager } = await setup();
    git(fixture.bare('web'), 'branch', branch, 'main');
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(/already exists on origin/);

    git(fixture.clone('academic'), 'remote', 'set-url', 'origin', 'https://github.com/attacker/kelolakelas-academic.git');
    await expect(manager.prepare({ taskId: taskA, repository: 'academic', branch, persisted: noPersisted })).rejects.toThrow(/does not point to github.com\/kelolakelas\/kelolakelas-academic/);
  });

  it('reports an unreachable remote as retryable', async () => {
    const { fixture, manager } = await setup();
    rmSync(fixture.bare('web'), { recursive: true, force: true });
    await expect(manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(RemoteUnavailableError);
    expect(git(fixture.clone('web'), 'config', '--default', '', '--get', `branch.${branch}.orchestratortask`)).toBe('');
  });

  it('does not run repository hooks and enforces disk capacity', async () => {
    const { fixture, manager } = await setup();
    const marker = join(fixture.base, 'hook-ran');
    writeFileSync(join(fixture.clone('web'), '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    expect(existsSync(marker)).toBe(false);

    const constrained = await setup({ workspace: { minimumFreeDiskMb: 1_000_000_000 } });
    await expect(constrained.manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted })).rejects.toThrow(/MB free/);
  });

  it('serializes concurrent preparation in one repository and isolates tasks', async () => {
    const { manager } = await setup();
    const [first, second] = await Promise.all([
      manager.prepare({ taskId: taskA, repository: 'web', branch: 'kel-1-first', persisted: noPersisted }),
      manager.prepare({ taskId: taskB, repository: 'web', branch: 'kel-2-second', persisted: noPersisted }),
    ]);
    expect(first.workspacePath).not.toBe(second.workspacePath);
    const conflicting = await Promise.allSettled([
      manager.prepare({ taskId: taskA, repository: 'academic', branch: 'kel-3-same', persisted: noPersisted }),
      manager.prepare({ taskId: taskB, repository: 'academic', branch: 'kel-3-same', persisted: noPersisted }),
    ]);
    expect(conflicting.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('releases only clean orchestrator-owned worktrees and keeps the branch', async () => {
    const { fixture, manager, registry } = await setup();
    const prepared = await manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    writeFileSync(join(prepared.workspacePath, 'draft.txt'), 'uncommitted\n');
    const release = { taskId: taskA, repository: 'web' as const, workspacePath: prepared.workspacePath, branch };
    expect(await manager.release(release)).toEqual({ released: false, reason: 'Worktree has uncommitted or untracked changes' });
    expect(existsSync(join(prepared.workspacePath, 'draft.txt'))).toBe(true);

    expect(await manager.release({ ...release, taskId: taskB, workspacePath: registry.worktreePath(taskB, 'web') })).toEqual({ released: true });
    expect(await manager.release({ ...release, workspacePath: fixture.clone('web') })).toMatchObject({ released: false });

    rmSync(join(prepared.workspacePath, 'draft.txt'));
    expect(await manager.release(release)).toEqual({ released: true });
    expect(existsSync(prepared.workspacePath)).toBe(false);
    expect(existsSync(join(registry.workspaceRoot, taskA))).toBe(false);
    expect(git(fixture.clone('web'), 'branch', '--list', branch)).toContain(branch);
    expect(await manager.release(release)).toEqual({ released: true });
  });

  it('refuses to release a user worktree placed at the orchestrator path', async () => {
    const { fixture, manager, registry } = await setup();
    const path = registry.worktreePath(taskA, 'web');
    git(fixture.clone('web'), 'worktree', 'add', '-q', '-b', 'user-branch', path);
    expect(await manager.release({ taskId: taskA, repository: 'web', workspacePath: path, branch: 'user-branch' })).toEqual({ released: false, reason: 'Worktree ownership does not match this task' });
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a workspace root that resolves through a symlink into a repository', async () => {
    const { fixture } = await setup();
    const link = join(fixture.base, 'linked-root');
    symlinkSync(fixture.clone('web'), link);
    const config = fixture.config();
    await expect(RepositoryRegistry.load({ ...config, workspace: { ...config.workspace!, root: link } })).rejects.toThrow(/overlap the workspace root/);
  });
});

describe('task workspace verification, restore, and commit', () => {
  async function prepared() {
    const context = await setup();
    const workspace = await context.manager.prepare({ taskId: taskA, repository: 'web', branch, persisted: noPersisted });
    return { ...context, identity: { taskId: taskA, repository: 'web' as const, workspacePath: workspace.workspacePath, branch, baseCommit: workspace.baseCommit } };
  }

  it('commits agent changes with the orchestrator identity and discards uncommitted output', async () => {
    const { manager, identity } = await prepared();
    expect(await manager.verifyTaskWorkspace(identity)).toEqual({ head: identity.baseCommit });

    writeFileSync(join(identity.workspacePath, 'feature.txt'), 'ready\n');
    const { commit, parent } = await manager.commitWorkspace(identity, 'KEL-1: implement\n\nOrchestrator-Task: x', { name: 'Orchestrator', email: 'bot@example.test' });
    expect(parent).toBe(identity.baseCommit);
    expect(git(identity.workspacePath, 'log', '-1', '--format=%H %an <%ae> %s')).toBe(`${commit} Orchestrator <bot@example.test> KEL-1: implement`);
    expect(await manager.verifyTaskWorkspace(identity)).toEqual({ head: commit });

    writeFileSync(join(identity.workspacePath, 'feature.txt'), 'partial');
    mkdirSync(join(identity.workspacePath, 'scratch'));
    writeFileSync(join(identity.workspacePath, 'scratch', 'notes.txt'), 'partial');
    expect(await manager.restoreWorkspace(identity)).toEqual({ head: commit, discarded: true });
    expect(git(identity.workspacePath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await manager.restoreWorkspace(identity)).toEqual({ head: commit, discarded: false });
  });

  it('refuses a worktree whose Git pointer, branch, or history an agent changed', async () => {
    const { fixture, manager, identity } = await prepared();

    // An agent can write the worktree's .git file; pointing it at another repository must not be trusted.
    const pointer = join(identity.workspacePath, '.git');
    const original = git(identity.workspacePath, 'rev-parse', '--git-dir');
    writeFileSync(pointer, `gitdir: ${join(fixture.clone('academic'), '.git')}\n`);
    await expect(manager.verifyTaskWorkspace(identity)).rejects.toThrow(WorkspaceBlockedError);
    await expect(manager.restoreWorkspace(identity)).rejects.toThrow(/no longer points to the web repository|is not on branch/);
    writeFileSync(pointer, `gitdir: ${original}\n`);
    await manager.verifyTaskWorkspace(identity);

    git(identity.workspacePath, 'checkout', '-q', '-b', 'agent-branch');
    await expect(manager.verifyTaskWorkspace(identity)).rejects.toThrow(/not on branch|not locked by the orchestrator/);
    git(identity.workspacePath, 'checkout', '-q', branch);

    git(identity.workspacePath, 'checkout', '-q', '--orphan', 'orphan');
    git(identity.workspacePath, 'commit', '-q', '--allow-empty', '-m', 'rewrite');
    git(identity.workspacePath, 'branch', '-q', '-f', branch, 'HEAD');
    git(identity.workspacePath, 'checkout', '-q', branch);
    await expect(manager.verifyTaskWorkspace(identity)).rejects.toThrow(/no longer descends from base/);

    await expect(manager.verifyTaskWorkspace({ ...identity, taskId: taskB })).rejects.toThrow(WorkspaceBlockedError);
  });
});
