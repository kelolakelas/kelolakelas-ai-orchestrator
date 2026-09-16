import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { validatePlanningIssue } from '../src/intake/planning-contract.js';
import { Scheduler } from '../src/orchestrator/scheduler.js';
import { OperatorRepository } from '../src/repositories/operator.repository.js';
import { TaskRepository, WorkspaceIdentityConflictError } from '../src/repositories/task.repository.js';
import { GitRunner } from '../src/workspaces/git.js';
import { workspacesPreparedCheckpoint, WorkspacePreparationStage } from '../src/workspaces/preparation-stage.js';
import { PostgresRepositoryLock, RepositoryLockTimeoutError } from '../src/workspaces/repository-lock.js';
import { RepositoryRegistry } from '../src/workspaces/repository-registry.js';
import { WorkspaceJanitor } from '../src/workspaces/workspace-janitor.js';
import { WorkspaceManager } from '../src/workspaces/workspace-manager.js';
import { insideHours } from './support/config.js';
import { createGitFixture, git, type GitFixture } from './support/git-fixture.js';
import { resetDatabase } from './support/database.js';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

function contract(draftKey: string, linearId: string, repositories: Array<'web' | 'academic'>, branch: string) {
  return validatePlanningIssue({
    draftKey, projectKey: null, title: draftKey, type: 'Feature', priority: 'High', estimate: 'S', complexity: 'low',
    labels: [...repositories, 'ai-ready'], repositories, blockedByDraftKeys: [], externalDependencies: [],
    body: { backgroundProblem: 'Problem', goal: 'Goal', requirements: ['Requirement'], acceptanceCriteria: ['Criterion'], technicalNotes: 'Notes', relevantAreas: ['src'], edgeCases: ['Edge'], testingValidation: ['Test'], outOfScope: ['None'] },
    source: { linearIssueId: linearId, linearIdentifier: `KEL-${linearId}`, linearCreatedAt: '2026-09-15T10:00:00.000Z', gitBranchName: branch, linearBlockedByIdentifiers: [] },
  });
}

// Real Git and PostgreSQL commits: allow for slow disks rather than the 5 second default.
describeIntegration('workspace preparation with PostgreSQL', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let tasks: TaskRepository;
  let operator: OperatorRepository;
  let fixture: GitFixture;
  let manager: WorkspaceManager;
  const operatorContext = { actor: 'ops@example.test', reason: 'integration test' };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzle(pool, { schema });
    tasks = new TaskRepository(db);
    operator = new OperatorRepository(db);
  });

  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    fixture = createGitFixture(['web', 'academic']);
    const registry = await RepositoryRegistry.load(fixture.config());
    manager = new WorkspaceManager(registry, new GitRunner(30_000), new PostgresRepositoryLock(pool, 10_000), { minimumFreeDiskMb: 0 });
  });

  afterEach(() => (fixture as GitFixture | undefined)?.cleanup());

  async function createTask(issue: ReturnType<typeof contract>, blockerTaskIds: string[] = []) {
    return tasks.createTask({
      linearIssueId: issue.source!.linearIssueId,
      linearIdentifier: issue.source!.linearIdentifier,
      contractSnapshot: issue as unknown as Record<string, unknown>,
      complexity: issue.complexity,
      blockerTaskIds,
      workUnits: issue.repositories.map((repository) => ({ repository })),
    });
  }

  function worker(workerId = 'worker-workspaces', clock: () => Date = () => insideHours) {
    return new Scheduler({
      config: fixture.config(),
      linear: { listIssues: async () => [] },
      tasks,
      operator,
      workerId,
      dryRun: false,
      log: (event, fields) => { if (process.env.DEBUG_WORKSPACE_TEST) console.log(event, JSON.stringify(fields)); },
      handlers: { ANALYZING: new WorkspacePreparationStage(manager, tasks, { workerId, remoteRetryMs: 60_000, clock }) },
      maintenance: [new WorkspaceJanitor(manager, tasks, () => undefined)],
      clock,
    });
  }

  it('prepares every declared repository, persists identities, and reuses them after an operator retry', async () => {
    const branch = 'kel-1-multi-repository';
    const task = await createTask(contract('multi-repository', '1', ['web', 'academic'], branch));
    const remoteHead = fixture.pushRemoteCommit('academic', 'new.txt');

    const instance = worker();
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', leaseOwner: null, requiresManualIntervention: false });
    const units = await tasks.getWorkUnits(task.id);
    expect(units.map(({ repository, branch: unitBranch, baseCommit }) => ({ repository, unitBranch, baseCommit }))).toEqual([
      { repository: 'academic', unitBranch: branch, baseCommit: remoteHead },
      { repository: 'web', unitBranch: branch, baseCommit: git(fixture.clone('web'), 'rev-parse', 'origin/main') },
    ]);
    for (const unit of units) expect(git(unit.workspacePath!, 'rev-parse', 'HEAD')).toBe(unit.baseCommit);
    expect(await tasks.getCheckpoint(task.id, workspacesPreparedCheckpoint)).toMatchObject({ repositories: expect.arrayContaining([expect.objectContaining({ repository: 'web' })]) });
    expect(existsSync(join(fixture.workspaceRoot, task.id, 'academic'))).toBe(true);

    fixture.pushRemoteCommit('web', 'after.txt');
    await operator.retryTask(task.id, operatorContext);
    await instance.runOnce();
    await instance.drain();
    const reused = await tasks.getWorkUnits(task.id);
    expect(reused.map((unit) => unit.baseCommit)).toEqual(units.map((unit) => unit.baseCommit));
  });

  it('blocks for manual intervention when a dependency is not merged or ownership is ambiguous', async () => {
    const blocker = await createTask(contract('blocker', '10', ['web'], 'kel-10-blocker'));
    const dependent = await createTask(contract('dependent', '11', ['web'], 'kel-11-dependent'), [blocker.id]);
    // Simulate a dependent that was queued before its blocker regressed out of COMPLETED.
    await pool.query("UPDATE tasks SET state = 'ANALYZING', lease_owner = NULL WHERE id = $1", [dependent.id]);
    await pool.query("UPDATE tasks SET state = 'BLOCKED' WHERE id = $1", [blocker.id]);

    const instance = worker();
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(dependent.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true, lastError: expect.stringContaining('unmerged work: KEL-10 (BLOCKED)') });

    const userOwned = await createTask(contract('user-owned', '12', ['academic'], 'kel-12-user-owned'));
    git(fixture.clone('academic'), 'branch', 'kel-12-user-owned');
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(userOwned.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true, lastError: expect.stringContaining('without orchestrator ownership') });
    expect(existsSync(join(fixture.workspaceRoot, userOwned.id))).toBe(false);
  });

  it('pauses when the remote is unreachable and resumes preparation later', async () => {
    const task = await createTask(contract('offline', '20', ['web'], 'kel-20-offline'));
    renameSync(fixture.bare('web'), `${fixture.bare('web')}.offline`);
    let now = insideHours;

    const instance = worker('worker-workspaces', () => now);
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'PAUSED_LIMIT', resumeState: 'ANALYZING', pauseReason: 'REMOTE_UNAVAILABLE', requiresManualIntervention: false });
    expect(await tasks.getWorkUnits(task.id)).toMatchObject([{ workspacePath: null, baseCommit: null }]);

    renameSync(`${fixture.bare('web')}.offline`, fixture.bare('web'));
    await instance.runOnce();
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'PAUSED_LIMIT' });

    now = new Date(insideHours.getTime() + 61_000);
    await instance.runOnce();
    await instance.drain();
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: false });
    expect(await tasks.getWorkUnits(task.id)).toMatchObject([{ workspacePath: join(fixture.workspaceRoot, task.id, 'web'), baseCommit: expect.any(String) }]);
  });

  it('releases clean workspaces of cancelled tasks and keeps dirty ones with a recorded reason', async () => {
    const clean = await createTask(contract('clean', '30', ['web'], 'kel-30-clean'));
    const dirty = await createTask(contract('dirty', '31', ['academic'], 'kel-31-dirty'));
    const instance = worker();
    await instance.runOnce();
    await instance.drain();
    await instance.runOnce();
    await instance.drain();
    const [cleanUnit] = await tasks.getWorkUnits(clean.id);
    const [dirtyUnit] = await tasks.getWorkUnits(dirty.id);
    writeFileSync(join(dirtyUnit!.workspacePath!, 'notes.txt'), 'operator notes\n');

    await operator.cancelTask(clean.id, operatorContext);
    await operator.cancelTask(dirty.id, operatorContext);
    await instance.runOnce();

    expect(await tasks.getWorkUnits(clean.id)).toMatchObject([{ workspaceReleasedAt: expect.any(Date), workspaceCleanupBlockedReason: null }]);
    expect(existsSync(cleanUnit!.workspacePath!)).toBe(false);
    expect(git(fixture.clone('web'), 'branch', '--list', 'kel-30-clean')).toContain('kel-30-clean');
    expect(await tasks.getWorkUnits(dirty.id)).toMatchObject([{ workspaceReleasedAt: null, workspaceCleanupBlockedReason: 'Worktree has uncommitted or untracked changes' }]);
    expect(existsSync(join(dirtyUnit!.workspacePath!, 'notes.txt'))).toBe(true);
  });

  it('rejects a second work unit recording the same branch or workspace path', async () => {
    const first = await createTask(contract('first', '40', ['web'], 'kel-40-shared'));
    const second = await createTask(contract('second', '41', ['web'], 'kel-40-shared'));
    await pool.query('UPDATE tasks SET lease_owner = $1 WHERE id = ANY($2)', ['worker-unique', [first.id, second.id]]);
    const identity = { repository: 'web', workspacePath: join(fixture.workspaceRoot, first.id, 'web'), branch: 'kel-40-shared', baseCommit: 'a'.repeat(40) };
    await tasks.recordWorkUnitWorkspace(first.id, 'worker-unique', identity);
    await expect(tasks.recordWorkUnitWorkspace(second.id, 'worker-unique', { ...identity, workspacePath: join(fixture.workspaceRoot, second.id, 'web') }))
      .rejects.toThrow(WorkspaceIdentityConflictError);
    await expect(tasks.recordWorkUnitWorkspace(first.id, 'another-worker', identity)).rejects.toThrow('leased by another worker');
  });

  it('holds repository locks across connections until the operation completes', async () => {
    const lock = new PostgresRepositoryLock(pool, 300, 25);
    let release!: () => void;
    const held = lock.withLock('web', () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(lock.withLock('web', async () => 'second')).rejects.toThrow(RepositoryLockTimeoutError);
    expect(await lock.withLock('academic', async () => 'independent')).toBe('independent');
    release();
    await held;
    expect(await lock.withLock('web', async () => 'after')).toBe('after');
  });
});
