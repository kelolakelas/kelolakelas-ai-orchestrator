import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { classifyDeliveryError, LinearSyncError, untrustedText, type DeliveryDependencies } from '../src/delivery/delivery-support.js';
import { pullRequestBody } from '../src/delivery/pull-request-stage.js';
import { evaluateRequiredChecks, summarizeReviews } from '../src/delivery/required-checks.js';
import { validatePlanningIssue } from '../src/intake/planning-contract.js';
import { canTransition } from '../src/orchestrator/state-machine.js';
import { GitHubRequestError, type BranchPolicy, type CheckResult } from '../src/providers/github.js';
import { LinearGraphqlProvider } from '../src/providers/linear.js';
import type { PersistedTask } from '../src/repositories/task.repository.js';
import { claimLaneOf } from '../src/types/domain.js';
import { WorkspaceBlockedError } from '../src/workspaces/repository-registry.js';
import { RemoteUnavailableError } from '../src/workspaces/workspace-manager.js';
import { testConfig } from './support/config.js';

const policy: BranchPolicy = {
  protected: true,
  requiredChecks: [{ context: 'gate', appId: 15368, source: 'branch-protection' }, { context: 'lint', appId: null, source: 'ruleset' }],
  requiredApprovingReviews: 1,
};
const run = (name: string, status: string, conclusion: string | null, appId: number | null = 15368): CheckResult => ({ name, kind: 'check-run', status, conclusion, appId, updatedAt: null });
const status = (name: string, state: 'pending' | 'success' | 'failure'): CheckResult => ({ name, kind: 'status', status: state === 'pending' ? 'pending' : 'completed', conclusion: state === 'pending' ? null : state, appId: null, updatedAt: null });

describe('required check evaluation', () => {
  it('passes only when every required check explicitly succeeded', () => {
    expect(evaluateRequiredChecks(policy, [run('gate', 'completed', 'success'), status('lint', 'success'), run('optional', 'completed', 'failure')])).toMatchObject({
      outcome: 'passed',
      checks: [{ context: 'gate', state: 'success' }, { context: 'lint', state: 'success' }],
    });
  });

  it('treats skipped, neutral, cancelled, stale, and timed-out conclusions as failures', () => {
    for (const conclusion of ['skipped', 'neutral', 'cancelled', 'stale', 'timed_out', 'action_required', 'failure', 'startup_failure']) {
      expect(evaluateRequiredChecks(policy, [run('gate', 'completed', conclusion), status('lint', 'success')]).outcome, conclusion).toBe('failed');
    }
    expect(evaluateRequiredChecks(policy, [run('gate', 'completed', 'success'), status('lint', 'failure')]).outcome).toBe('failed');
  });

  it('keeps missing and pending checks pending, and ignores same-named checks from another app', () => {
    expect(evaluateRequiredChecks(policy, [status('lint', 'success')])).toMatchObject({ outcome: 'pending', checks: [{ context: 'gate', state: 'missing' }, { context: 'lint', state: 'success' }] });
    expect(evaluateRequiredChecks(policy, [run('gate', 'in_progress', null), status('lint', 'success')]).outcome).toBe('pending');
    expect(evaluateRequiredChecks(policy, [run('gate', 'completed', 'success', 99), status('lint', 'success')]).checks[0]).toMatchObject({ state: 'missing' });
    // An unpinned requirement is failed by any matching report that failed.
    expect(evaluateRequiredChecks(policy, [run('gate', 'completed', 'success'), run('lint', 'completed', 'success', 1), status('lint', 'failure')]).outcome).toBe('failed');
  });

  it('never reports success for a branch without required checks', () => {
    expect(evaluateRequiredChecks({ protected: false, requiredChecks: [], requiredApprovingReviews: null }, [run('gate', 'completed', 'success')])).toEqual({ outcome: 'no-policy', checks: [] });
  });

  it('summarizes the latest decisive review per reviewer', () => {
    const head = 'c'.repeat(40);
    const reviews = [
      { reviewer: 'alice', state: 'CHANGES_REQUESTED', commitId: 'old', submittedAt: '2026-09-16T01:00:00Z' },
      { reviewer: 'alice', state: 'COMMENTED', commitId: head, submittedAt: '2026-09-16T02:00:00Z' },
      { reviewer: 'alice', state: 'APPROVED', commitId: head, submittedAt: '2026-09-16T03:00:00Z' },
      { reviewer: 'bob', state: 'APPROVED', commitId: 'old', submittedAt: '2026-09-16T01:00:00Z' },
      { reviewer: 'carol', state: 'CHANGES_REQUESTED', commitId: head, submittedAt: '2026-09-16T01:00:00Z' },
      { reviewer: 'dave', state: 'APPROVED', commitId: head, submittedAt: '2026-09-16T01:00:00Z' },
      { reviewer: 'dave', state: 'DISMISSED', commitId: head, submittedAt: '2026-09-16T04:00:00Z' },
    ];
    expect(summarizeReviews(reviews, head, 1)).toEqual({ approvedBy: ['alice', 'bob'], changesRequestedBy: ['carol'], approvalsOnHead: 1, requiredApprovingReviews: 1 });
  });
});

describe('delivery text and outcomes', () => {
  it('neutralizes mentions, issue references, control characters, and credentials in untrusted text', () => {
    const text = untrustedText('Hi @team, fixes #42  token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD and known-secret-value', ['known-secret-value'], 1_000);
    expect(text).not.toMatch(/@team|#42||ghp_|known-secret-value/);
    expect(text).toContain('[REDACTED]');
    expect(untrustedText('x'.repeat(20), [], 5)).toBe('xxxxx…');
  });

  it('builds a pull request body from trusted identities and neutralized issue and reviewer text', () => {
    const contract = validatePlanningIssue({
      draftKey: 'feature', projectKey: null, title: 'Feature', type: 'Feature', priority: 'High', estimate: 'S', complexity: 'low',
      labels: ['web', 'ai-ready'], repositories: ['web'], blockedByDraftKeys: [], externalDependencies: [],
      body: { backgroundProblem: 'P', goal: 'Ping @all', requirements: ['R'], acceptanceCriteria: ['Closes #7'], technicalNotes: 'N', relevantAreas: ['a'], edgeCases: ['e'], testingValidation: ['t'], outOfScope: ['o'] },
      source: { linearIssueId: 'issue', linearIdentifier: 'KEL-9', linearCreatedAt: '2026-09-15T10:00:00.000Z', gitBranchName: 'kel-9-feature', linearBlockedByIdentifiers: [] },
    });
    const body = pullRequestBody({
      task: { id: '5d0b7c52-7f55-4bf1-9d4f-3d2b3f0ae001', linearIdentifier: 'KEL-9' } as PersistedTask,
      contract, repository: 'web', commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), checks: ['lint', 'test'],
      reviewSummary: 'Approve; resolves #3 for @owner', siblingRepositories: ['academic'], knownSecrets: [],
    });
    expect(body).toContain('Implements Linear issue **KEL-9** in `web`.');
    expect(body).toContain('`lint`, `test`');
    expect(body).toContain('also changes: `academic`');
    expect(body).toContain('<!-- kelolakelas-ai-orchestrator task=5d0b7c52-7f55-4bf1-9d4f-3d2b3f0ae001 repository=web -->');
    expect(body).not.toMatch(/@all|#7|#3|@owner/);
  });

  it('waits on transient provider failures and hands rejections and ownership problems to an operator', () => {
    const now = new Date('2026-09-16T10:00:00.000Z');
    const deps = { clock: () => now, knownSecrets: ['ghs_known'], delivery: { retryIntervalSeconds: 300 } } as unknown as DeliveryDependencies;
    expect(classifyDeliveryError(deps, new GitHubRequestError('502 ghs_known', 'transient', 502))).toEqual({
      category: 'provider-unavailable', outcome: { kind: 'wait', until: new Date(now.getTime() + 300_000), reason: 'GitHub unavailable', lastError: '502 [REDACTED]' },
    });
    expect(classifyDeliveryError(deps, new GitHubRequestError('limited', 'rate-limit', 429, new Date(now.getTime() + 60_000))).outcome).toMatchObject({ kind: 'wait', until: new Date(now.getTime() + 60_000) });
    expect(classifyDeliveryError(deps, new RemoteUnavailableError('web', new Error('offline'))).outcome).toMatchObject({ kind: 'wait' });
    expect(classifyDeliveryError(deps, new LinearSyncError('comment', new Error('503'))).category).toBe('linear-unavailable');
    for (const error of [new GitHubRequestError('Bad credentials', 'auth', 401), new GitHubRequestError('invalid', 'invalid-response', null), new WorkspaceBlockedError('not owned')]) {
      expect(classifyDeliveryError(deps, error).outcome).toMatchObject({ kind: 'advance', to: 'BLOCKED', requiresManualIntervention: true });
    }
    expect(() => classifyDeliveryError(deps, new Error('unexpected'))).toThrow('unexpected');
  });

  it('runs delivery states in their own claim lane and lets human review return to CI or block', () => {
    expect(['PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW'].map((state) => claimLaneOf(state as never))).toEqual(['delivery', 'delivery', 'delivery']);
    expect(claimLaneOf('REVIEWING')).toBe('execution');
    expect(canTransition('READY_FOR_HUMAN_REVIEW', 'WAITING_CI')).toBe(true);
    expect(canTransition('READY_FOR_HUMAN_REVIEW', 'BLOCKED')).toBe(true);
    expect(canTransition('WAITING_CI', 'COMPLETED')).toBe(false);
  });
});

describe('delivery configuration', () => {
  it('requires agent execution and a delivery section, with safe defaults', () => {
    const base = testConfig();
    const issues = (input: Record<string, unknown>) => {
      try {
        validateConfig(input);
        return [];
      } catch (error) {
        return (error as { issues: Array<{ message: string }> }).issues.map((issue) => issue.message);
      }
    };
    expect(issues({ ...base, orchestrator: { ...base.orchestrator, execution: { deliver: true } } })).toEqual(expect.arrayContaining([
      'must be true when orchestrator.execution.deliver is true',
      'is required when orchestrator.execution.deliver is true',
    ]));
    const config = validateConfig({ ...base, delivery: {} });
    expect(config.orchestrator.execution.deliver).toBe(false);
    expect(config.orchestrator.maxConcurrentDeliveryTasks).toBe(2);
    expect(config.delivery).toEqual({
      github: { apiUrl: 'https://api.github.com', requestTimeoutMs: 15_000, maxRetries: 3 },
      pollIntervalSeconds: 120, retryIntervalSeconds: 300, requiredChecksTimeoutMinutes: 180, draftPullRequests: false, linearComments: true,
    });
    expect(issues({ ...base, delivery: { pollIntervalSeconds: 1 } })).toEqual([expect.stringContaining('greater than or equal to 10')]);
  });
});

describe('Linear issue writer', () => {
  const config = { teamKey: 'KEL', requiredLabels: [], excludedLabels: [], apiUrl: 'https://linear.test/graphql', requestTimeoutMs: 1_000, maxRetries: 2 };

  it('pages through comments and never retries a mutation', async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    let failMutation = true;
    const provider = new LinearGraphqlProvider(config, 'lin_api_key', async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      bodies.push(body);
      if (body.query.includes('commentCreate')) {
        if (failMutation) return new Response('', { status: 502 });
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c-9' } } } }));
      }
      if (body.query.includes('attachmentCreate')) return new Response(JSON.stringify({ data: { attachmentCreate: { success: true, attachment: { id: 'a-1' } } } }));
      const page = body.variables.after === null
        ? { nodes: [{ id: 'c-1', body: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'cursor' } }
        : { nodes: [{ id: 'c-2', body: 'second' }], pageInfo: { hasNextPage: false, endCursor: null } };
      return new Response(JSON.stringify({ data: { issue: { comments: page } } }));
    });

    expect(await provider.listComments('issue-1')).toEqual([{ id: 'c-1', body: 'first' }, { id: 'c-2', body: 'second' }]);
    await expect(provider.createComment('issue-1', 'hello')).rejects.toThrow('Linear request failed: 502');
    expect(bodies.filter((body) => body.query.includes('commentCreate'))).toHaveLength(1);
    failMutation = false;
    expect(await provider.createComment('issue-1', 'hello')).toEqual({ id: 'c-9' });
    expect(await provider.attachLink('issue-1', { url: 'https://github.com/o/r/pull/1', title: 'PR', subtitle: 'KEL-1' })).toEqual({ id: 'a-1' });
    expect(bodies.at(-1)?.variables).toEqual({ input: { issueId: 'issue-1', url: 'https://github.com/o/r/pull/1', title: 'PR', subtitle: 'KEL-1' } });
  });
});
