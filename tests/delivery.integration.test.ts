import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig, type OrchestratorConfig } from '../src/config/schema.js';
import * as schema from '../src/db/schema.js';
import { implementationResultVersion, reviewResultVersion } from '../src/execution/agent-results.js';
import type { AgentRunner, AgentRunRequest, AgentRunResult } from '../src/execution/agent-runner.js';
import { DocumentationLoader } from '../src/execution/documentation.js';
import { QualityGateRunner } from '../src/execution/quality-gates.js';
import { createExecutionHandlers } from '../src/execution/stages/index.js';
import { WorkspaceChanges } from '../src/execution/workspace-changes.js';
import { validatePlanningIssue } from '../src/intake/planning-contract.js';
import { Scheduler } from '../src/orchestrator/scheduler.js';
import { GitHubRequestError } from '../src/providers/github.js';
import { OperatorRepository } from '../src/repositories/operator.repository.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { GitRunner } from '../src/workspaces/git.js';
import { PostgresRepositoryLock } from '../src/workspaces/repository-lock.js';
import { RepositoryRegistry } from '../src/workspaces/repository-registry.js';
import { WorkspaceJanitor } from '../src/workspaces/workspace-janitor.js';
import { WorkspaceManager } from '../src/workspaces/workspace-manager.js';
import { analysisResult } from './support/agent-fixtures.js';
import { insideHours } from './support/config.js';
import { resetDatabase } from './support/database.js';
import { FakeGitHub, FakeLinear } from './support/fake-delivery.js';
import { createGitFixture, git, type GitFixture } from './support/git-fixture.js';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

type Repository = 'web' | 'academic';
const github = (repository: Repository) => `kelolakelas/kelolakelas-${repository}`;
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
const completed = (output: unknown): AgentRunResult<unknown> => ({ kind: 'completed', output, usage, durationMs: 1 });

/** Analyzes, implements "ready" in every declared repository, and approves. Delivery is what these tests exercise. */
class HappyRunner implements AgentRunner {
  calls = 0;

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    this.calls += 1;
    // The task directory contains exactly the declared repository worktrees.
    const repositories = readdirSync(request.taskDirectory).sort() as Repository[];
    let output: unknown;
    if (request.role === 'analyzer') {
      output = analysisResult({ repositories: repositories.map((repository) => ({ repository, summary: `Update ${repository}`, changes: [{ path: 'feature.txt', action: 'create', rationale: 'Feature' }] })) });
    } else if (request.role === 'implementer') {
      for (const repository of repositories) {
        writeFileSync(join(request.taskDirectory, repository, 'feature.txt'), 'ready\n');
      }
      output = { schemaVersion: implementationResultVersion, status: 'completed', summary: 'Implemented', blockedReason: null, repositories: repositories.map((repository) => ({ repository, summary: 'Implemented' })), validation: [] };
    } else {
      output = { schemaVersion: reviewResultVersion, verdict: 'approve', summary: 'Looks right; ping @someone and fixes #12', findings: [] };
    }
    const parsed = request.resultSchema.safeParse(output);
    if (!parsed.success) throw new Error(`Invalid scripted ${request.role} output`);
    return { ...completed(parsed.data), output: parsed.data } as AgentRunResult<T>;
  }
}

function contract(key: string, id: string, repositories: Repository[]) {
  return validatePlanningIssue({
    draftKey: key, projectKey: null, title: `Implement ${key}`, type: 'Feature', priority: 'High', estimate: 'S', complexity: 'low',
    labels: [...repositories, 'ai-ready'], repositories, blockedByDraftKeys: [], externalDependencies: [],
    body: { backgroundProblem: 'Problem', goal: 'Goal for @everyone', requirements: ['Requirement'], acceptanceCriteria: ['feature.txt says ready'], technicalNotes: 'Notes', relevantAreas: ['feature.txt'], edgeCases: ['Edge'], testingValidation: ['check'], outOfScope: ['None'] },
    source: { linearIssueId: `linear-${id}`, linearIdentifier: `KEL-${id}`, linearCreatedAt: '2026-09-15T10:00:00.000Z', gitBranchName: `kel-${id}-${key}`, linearBlockedByIdentifiers: [] },
  });
}

const checkScript = 'const fs = require("fs"); if (!fs.readFileSync("feature.txt", "utf8").includes("ready")) process.exit(1);';

// Real Git remotes, quality commands, and PostgreSQL: allow for slow disks.
describeIntegration('GitHub delivery and Linear synchronization with PostgreSQL and Git', { timeout: 120_000 }, () => {
  let pool: pg.Pool;
  let tasks: TaskRepository;
  let operator: OperatorRepository;
  let fixture: GitFixture;
  let githubFake: FakeGitHub;
  let linearFake: FakeLinear;
  let now: Date;
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
    githubFake = new FakeGitHub(fixture);
    linearFake = new FakeLinear();
    now = insideHours;
  });

  afterEach(() => (fixture as GitFixture | undefined)?.cleanup());

  function config(): OrchestratorConfig {
    const base = fixture.config();
    const quality = { checks: [{ name: 'feature', command: [process.execPath, '-e', checkScript], timeoutSeconds: 30 }] };
    return validateConfig({
      ...base,
      orchestrator: { ...base.orchestrator, maxConcurrentTasks: 1, execution: { prepareWorkspaces: true, runAgents: true, deliver: true } },
      models: { analyzer: { tier: 'terra', effort: 'high' }, reviewer: { tier: 'terra', effort: 'high' }, tiers: { luna: { model: 'model-luna' }, terra: { model: 'model-terra' }, sol: { model: 'model-sol' } } },
      repositories: Object.fromEntries(Object.entries(base.repositories).map(([name, repository]) => [name, { ...repository, quality }])),
      agents: { runner: { executable: '/usr/local/bin/codex' }, commitAuthor: { name: 'KelolaKelas Orchestrator', email: 'orchestrator@example.test' } },
      delivery: { pollIntervalSeconds: 60, retryIntervalSeconds: 120, requiredChecksTimeoutMinutes: 30 },
    });
  }

  async function worker(runner: AgentRunner = new HappyRunner()) {
    const orchestratorConfig = config();
    const registry = await RepositoryRegistry.load(orchestratorConfig);
    const gitRunner = new GitRunner(30_000);
    const workspaces = new WorkspaceManager(registry, gitRunner, new PostgresRepositoryLock(pool, 10_000), { minimumFreeDiskMb: 0 });
    const knownSecrets = ['delivery-known-secret-value'];
    const handlers = createExecutionHandlers({
      config: orchestratorConfig,
      agents: orchestratorConfig.agents!,
      tasks,
      registry,
      workspaces,
      changes: new WorkspaceChanges(gitRunner),
      runner,
      quality: new QualityGateRunner({ quality: (repository) => orchestratorConfig.repositories[repository as Repository]!.quality, sourceEnvironment: process.env, knownSecrets }),
      documentation: new DocumentationLoader(undefined, orchestratorConfig.repositories),
      workerId: 'worker-delivery',
      knownSecrets,
      clock: () => now,
    }, { remoteRetryMs: 60_000 }, { delivery: orchestratorConfig.delivery!, github: githubFake, linear: linearFake });
    return new Scheduler({
      config: orchestratorConfig,
      linear: { listIssues: async () => [] },
      tasks,
      operator,
      workerId: 'worker-delivery',
      dryRun: false,
      log: (event, fields) => { if (process.env.DEBUG_DELIVERY_TEST) console.log(event, JSON.stringify(fields)); },
      handlers,
      maintenance: [new WorkspaceJanitor(workspaces, tasks, () => undefined)],
      clock: () => now,
    });
  }

  async function tick(scheduler: Scheduler, advanceSeconds = 0): Promise<void> {
    now = new Date(now.getTime() + advanceSeconds * 1_000);
    await scheduler.runOnce();
    await scheduler.drain();
  }

  async function createTask(key: string, id: string, repositories: Repository[]) {
    const issue = contract(key, id, repositories);
    return tasks.createTask({
      linearIssueId: issue.source!.linearIssueId,
      linearIdentifier: issue.source!.linearIdentifier,
      contractSnapshot: issue as unknown as Record<string, unknown>,
      complexity: issue.complexity,
      workUnits: repositories.map((repository) => ({ repository })),
    });
  }

  async function transitions(taskId: string): Promise<string[]> {
    const result = await pool.query<{ from_state: string; to_state: string }>('SELECT from_state, to_state FROM state_transitions WHERE task_id = $1 ORDER BY created_at, id', [taskId]);
    return result.rows.map((row) => `${row.from_state}->${row.to_state}`);
  }

  async function unit(taskId: string, repository: Repository) {
    return (await tasks.getWorkUnits(taskId)).find((entry) => entry.repository === repository)!;
  }

  async function operations(taskId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const operation of await tasks.listExternalOperations(taskId)) {
      expect(operation.status).toBe('SUCCEEDED');
      counts[operation.operationType] = (counts[operation.operationType] ?? 0) + 1;
    }
    return counts;
  }

  async function passChecks(taskId: string, repository: Repository, conclusion: string | null = 'success'): Promise<string> {
    const head = githubFake.branchHead(github(repository), (await unit(taskId, repository)).branch!)!;
    githubFake.setCheck(github(repository), head, conclusion);
    return head;
  }

  it('delivers one pull request per repository, waits without holding a lease, reports partial merges, and completes only when every merge is reachable', async () => {
    const scheduler = await worker();
    const task = await createTask('delivered', '1', ['web', 'academic']);

    await tick(scheduler);

    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'WAITING_CI', leaseOwner: null, requiresManualIntervention: false, lastError: null, resumeAfter: new Date(now.getTime() + 60_000) });
    expect((await transitions(task.id)).slice(-3)).toEqual(['TESTING->REVIEWING', 'REVIEWING->PR_CREATED', 'PR_CREATED->WAITING_CI']);
    for (const repository of ['web', 'academic'] as const) {
      const delivered = await unit(task.id, repository);
      const local = git(delivered.workspacePath!, 'rev-parse', 'HEAD');
      expect(delivered).toMatchObject({ state: 'WAITING_CI', pushedCommit: local, pullRequestNumber: 1, pullRequestUrl: `https://github.com/${github(repository)}/pull/1` });
      expect(delivered.outcome).toContain('Required checks pending: gate missing');
      expect(githubFake.branchHead(github(repository), delivered.branch!)).toBe(local);
      const [pullRequest] = githubFake.pullRequests.filter((entry) => entry.repository === github(repository));
      expect(pullRequest).toMatchObject({ title: 'KEL-1: Implement delivered', baseRef: 'main', draft: false });
      expect(pullRequest!.body).toContain(`<!-- kelolakelas-ai-orchestrator task=${task.id} repository=${repository} -->`);
      // Untrusted issue and reviewer text cannot mention people or reference issues.
      expect(pullRequest!.body).not.toMatch(/@everyone|@someone|#12/);
    }
    expect(linearFake.attachments.get('linear-1')?.map((attachment) => attachment.url).sort()).toEqual([
      'https://github.com/kelolakelas/kelolakelas-academic/pull/1', 'https://github.com/kelolakelas/kelolakelas-web/pull/1',
    ]);
    expect(linearFake.commentsFor('linear-1')).toEqual([expect.stringContaining('**Pull requests opened**')]);

    // A pull request waiting for checks never blocks new work in the execution lane.
    const second = await createTask('parallel', '2', ['web']);
    const checksCalls = githubFake.calls.filter((call) => call === 'listChecks').length;
    await tick(scheduler, 10);
    expect(await tasks.getTask(second.id)).toMatchObject({ state: 'WAITING_CI' });
    // The first task was not observed again before its resume time.
    expect(githubFake.calls.filter((call) => call === 'listChecks').length).toBe(checksCalls + 1);

    await passChecks(task.id, 'web');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'WAITING_CI' });
    expect(await unit(task.id, 'web')).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW' });
    expect(await unit(task.id, 'academic')).toMatchObject({ state: 'WAITING_CI' });

    await passChecks(task.id, 'academic');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', leaseOwner: null });
    expect(linearFake.commentsFor('linear-1')).toEqual([expect.stringContaining('Pull requests opened'), expect.stringContaining('**Required checks passed**')]);

    const webHead = githubFake.branchHead(github('web'), (await unit(task.id, 'web')).branch!)!;
    githubFake.addReview(github('web'), 1, { reviewer: 'alice', state: 'APPROVED', commitId: webHead, submittedAt: '2026-09-16T03:10:00Z' });
    githubFake.merge(github('web'), 1);
    await tick(scheduler, 60);
    // Partial delivery: one repository merged, the parent task is not complete.
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW' });
    const web = await unit(task.id, 'web');
    expect(web).toMatchObject({ state: 'COMPLETED', mergeCommit: githubFake.find(github('web'), 1).mergeCommitSha });
    expect(web.deliveryObservation).toMatchObject({ mergeCommitReachable: true });
    expect(await unit(task.id, 'academic')).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', mergeCommit: null });
    const detail = await operator.listWorkUnits(task.id);
    expect(detail.map((entry) => `${entry.repository}:${entry.state}`)).toEqual(['academic:READY_FOR_HUMAN_REVIEW', 'web:COMPLETED']);

    githubFake.merge(github('academic'), 1);
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'COMPLETED', leaseOwner: null, lastError: null });
    expect((await transitions(task.id)).slice(-3)).toEqual(['PR_CREATED->WAITING_CI', 'WAITING_CI->READY_FOR_HUMAN_REVIEW', 'READY_FOR_HUMAN_REVIEW->COMPLETED']);
    const comments = linearFake.commentsFor('linear-1');
    expect(comments).toHaveLength(3);
    expect(comments[2]).toContain('**Every pull request is merged**');

    await tick(scheduler, 60);
    expect((await tasks.getWorkUnits(task.id)).every((entry) => entry.workspaceReleasedAt !== null)).toBe(true);
    expect(await operations(task.id)).toEqual({ GIT_PUSH: 2, GITHUB_PULL_REQUEST: 2, LINEAR_ATTACHMENT: 2, LINEAR_COMMENT: 3 });
    expect(githubFake.calls.filter((call) => call === 'createPullRequest')).toHaveLength(3);
  });

  it('never duplicates a push, pull request, or Linear update after a crash or lost response between a side effect and its record', async () => {
    const scheduler = await worker();
    const task = await createTask('recovered', '3', ['web']);

    // Crash right after the push is recorded, before any pull request lookup.
    githubFake.inject('findPullRequests', { when: 'before', error: () => new Error('worker crashed after push') });
    await tick(scheduler);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true, lastError: expect.stringContaining('worker crashed after push') });
    const pushed = await unit(task.id, 'web');
    expect(githubFake.branchHead(github('web'), pushed.branch!)).toBe(pushed.pushedCommit);

    // The pull request is created but the response is lost, then the worker crashes.
    githubFake.inject('createPullRequest', { when: 'after', error: () => new Error('worker crashed after creating the pull request') });
    await operator.retryTask(task.id, operatorContext);
    await tick(scheduler, 10);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true });
    expect(githubFake.pullRequests).toHaveLength(1);

    // The comment is created but its response is lost: a transient failure that waits and reconciles.
    linearFake.inject('createComment', { when: 'after', error: () => new Error('socket hang up') });
    await operator.retryTask(task.id, operatorContext);
    await tick(scheduler, 10);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'PR_CREATED', leaseOwner: null, requiresManualIntervention: false, lastError: expect.stringContaining('Linear comment failed: socket hang up') });

    // A GitHub rate limit also waits, until the provider's reset time.
    githubFake.inject('getRepository', { when: 'before', error: () => new GitHubRequestError('rate limited', 'rate-limit', 429, new Date(now.getTime() + 600_000)) });
    await tick(scheduler, 120);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'PR_CREATED', resumeAfter: new Date(now.getTime() + 600_000), lastError: 'rate limited' });

    await tick(scheduler, 600);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'WAITING_CI', requiresManualIntervention: false });
    expect(githubFake.pullRequests).toHaveLength(1);
    expect(githubFake.calls.filter((call) => call === 'createPullRequest')).toHaveLength(1);
    expect(linearFake.commentsFor('linear-3')).toHaveLength(1);
    expect(linearFake.attachments.get('linear-3')).toHaveLength(1);
    expect(await operations(task.id)).toEqual({ GIT_PUSH: 1, GITHUB_PULL_REQUEST: 1, LINEAR_ATTACHMENT: 1, LINEAR_COMMENT: 1 });
    expect(await unit(task.id, 'web')).toMatchObject({ pullRequestNumber: 1, pushedCommit: pushed.pushedCommit });

    // Retrying a waiting task's whole workflow reuses every side effect.
    await operator.requireManualIntervention(task.id, operatorContext);
    await operator.retryTask(task.id, operatorContext);
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'WAITING_CI' });
    expect(githubFake.calls.filter((call) => call === 'createPullRequest')).toHaveLength(1);
    expect(linearFake.commentsFor('linear-3')).toHaveLength(1);
  });

  it('never treats failed, skipped, or unreported required checks, or a missing policy, as success', async () => {
    const scheduler = await worker();
    const failed = await createTask('failed', '4', ['web']);
    await tick(scheduler);
    await passChecks(failed.id, 'web', 'failure');
    await tick(scheduler, 60);
    expect(await tasks.getTask(failed.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true, lastError: expect.stringContaining('Required check failed') });
    expect(linearFake.commentsFor('linear-4').at(-1)).toContain('**Delivery blocked**');

    // After CI is fixed and rerun on the same head, an operator retry resumes delivery without new side effects.
    await passChecks(failed.id, 'web', 'success');
    await operator.retryTask(failed.id, operatorContext);
    await tick(scheduler, 10);
    expect(await tasks.getTask(failed.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', requiresManualIntervention: false });
    expect(githubFake.pullRequests.filter((entry) => entry.headRef === 'kel-4-failed')).toHaveLength(1);

    const skipped = await createTask('skipped', '5', ['academic']);
    await tick(scheduler, 10);
    await passChecks(skipped.id, 'academic', 'skipped');
    githubFake.setCheck(github('academic'), githubFake.branchHead(github('academic'), 'kel-5-skipped')!, 'success', 'gate', 99);
    await tick(scheduler, 60);
    expect(await tasks.getTask(skipped.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('gate (skipped)') });

    const unreported = await createTask('unreported', '6', ['web']);
    await tick(scheduler, 10);
    // A same-named check from another app does not satisfy a requirement pinned to the gate app.
    githubFake.setCheck(github('web'), githubFake.branchHead(github('web'), 'kel-6-unreported')!, 'success', 'gate', 99);
    await tick(scheduler, 20 * 60);
    expect(await tasks.getTask(unreported.id)).toMatchObject({ state: 'WAITING_CI' });
    await tick(scheduler, 11 * 60);
    expect(await tasks.getTask(unreported.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('did not succeed within 30 minutes: gate missing') });

    githubFake.setPolicy(github('academic'), { protected: false, requiredChecks: [], requiredApprovingReviews: null });
    const unprotected = await createTask('unprotected', '7', ['academic']);
    await tick(scheduler, 10);
    expect(await tasks.getTask(unprotected.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('requires no status checks') });
  });

  it('follows an updated pull request branch back to CI, and blocks force-pushed, closed, or foreign-authored branches', async () => {
    const scheduler = await worker();
    const task = await createTask('updated', '8', ['web']);
    await tick(scheduler);
    await passChecks(task.id, 'web');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW' });

    // "Update branch" adds a commit on top of the reviewed commit: checks run again on the new head.
    const updated = githubFake.advanceBranch(github('web'), 'kel-8-updated', 'base-update.txt');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'WAITING_CI' });
    githubFake.setCheck(github('web'), updated, 'success');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW' });

    githubFake.forcePush(github('web'), 'kel-8-updated', 'rewritten.txt');
    await tick(scheduler, 60);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', requiresManualIntervention: true, lastError: expect.stringContaining('force-pushed') });
    // Retrying does not push over the rewritten branch.
    await operator.retryTask(task.id, operatorContext);
    await tick(scheduler, 10);
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('no longer contains the reviewed commit') });

    const closed = await createTask('closed', '9', ['academic']);
    await tick(scheduler, 10);
    githubFake.close(github('academic'), 1);
    await tick(scheduler, 60);
    expect(await tasks.getTask(closed.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('closed without merging') });
    await operator.retryTask(closed.id, operatorContext);
    await tick(scheduler, 10);
    expect(await tasks.getTask(closed.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('reopen it or cancel the task') });
    expect(githubFake.calls.filter((call) => call === 'createPullRequest')).toHaveLength(2);

    // GitHub reporting a merge is not enough: the merge commit must be reachable from the remote base branch.
    const unreachable = await createTask('unreachable', '11', ['academic']);
    await tick(scheduler, 10);
    await passChecks(unreachable.id, 'academic');
    await tick(scheduler, 60);
    githubFake.markMergedOutsideBase(github('academic'), 2);
    await tick(scheduler, 60);
    expect(await tasks.getTask(unreachable.id)).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW' });
    expect(await unit(unreachable.id, 'academic')).toMatchObject({ state: 'READY_FOR_HUMAN_REVIEW', mergeCommit: null, outcome: expect.stringContaining('not yet reachable from main') });
    await tick(scheduler, 31 * 60);
    expect(await tasks.getTask(unreachable.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('is not reachable from main') });

    // A commit that the orchestrator did not write never leaves the host, even when checkpoints are made to cover it.
    const foreign = await createTask('foreign', '10', ['web']);
    githubFake.inject('getRepository', { when: 'before', error: () => new Error('stop before delivery') });
    await tick(scheduler, 10);
    const workUnit = await unit(foreign.id, 'web');
    writeFileSync(join(workUnit.workspacePath!, 'extra.txt'), 'extra\n');
    git(workUnit.workspacePath!, 'add', '.');
    git(workUnit.workspacePath!, 'commit', '-q', '-m', 'human commit');
    const head = git(workUnit.workspacePath!, 'rev-parse', 'HEAD');
    await pool.query(`UPDATE task_checkpoints SET payload = jsonb_set(payload, '{heads,web}', to_jsonb($2::text)) WHERE task_id = $1 AND checkpoint_key IN ('quality-passed', 'review-approved')`, [foreign.id, head]);
    await pool.query("UPDATE tasks SET state = 'PR_CREATED', requires_manual_intervention = false WHERE id = $1", [foreign.id]);
    await tick(scheduler, 10);
    expect(await tasks.getTask(foreign.id)).toMatchObject({ state: 'BLOCKED', lastError: expect.stringContaining('was not authored by the orchestrator') });
    expect(githubFake.branchHead(github('web'), 'kel-10-foreign')).toBeNull();
  });
});
