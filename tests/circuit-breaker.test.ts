import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/providers/circuit-breaker.js';
import { GitHubRequestError, type GitHubProvider } from '../src/providers/github.js';
import { CircuitBreakingGitHubProvider, CircuitBreakingLinearProvider } from '../src/providers/guarded-providers.js';

function clock(start = new Date('2026-09-17T00:00:00Z')) {
  let now = start.getTime();
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

const counted = () => ({ counted: true });
const fail = () => Promise.reject(new Error('unavailable'));

describe('circuit breaker', () => {
  it('opens after consecutive counted failures, rejects without calling, and closes after a successful probe', async () => {
    const time = clock();
    const changes: string[] = [];
    const breaker = new CircuitBreaker('github', { failureThreshold: 3, openSeconds: 60 }, time.now, { onStateChange: (state) => changes.push(state) });

    for (let index = 0; index < 3; index += 1) await expect(breaker.execute(fail, counted)).rejects.toThrow('unavailable');
    expect(breaker.status()).toMatchObject({ state: 'open', consecutiveFailures: 3 });

    const operation = vi.fn().mockResolvedValue('ok');
    await expect(breaker.execute(operation, counted)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();

    time.advance(60_000);
    expect(breaker.status().state).toBe('half-open');
    await expect(breaker.execute(operation, counted)).resolves.toBe('ok');
    expect(breaker.status()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(changes).toEqual(['open', 'half-open', 'closed']);
  });

  it('re-opens when the probe fails and admits only one probe at a time', async () => {
    const time = clock();
    const breaker = new CircuitBreaker('linear', { failureThreshold: 1, openSeconds: 30 }, time.now);
    await expect(breaker.execute(fail, counted)).rejects.toThrow();
    time.advance(30_000);

    let release!: () => void;
    const slowProbe = breaker.execute(() => new Promise<void>((resolve) => { release = resolve; }).then(() => { throw new Error('still down'); }), counted);
    await expect(breaker.execute(async () => 'second', counted)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await expect(slowProbe).rejects.toThrow('still down');
    expect(breaker.status()).toMatchObject({ state: 'open', openUntil: new Date(time.now().getTime() + 30_000) });
  });

  it('does not count request-specific errors and resets the count on success', async () => {
    const breaker = new CircuitBreaker('github', { failureThreshold: 2, openSeconds: 30 }, clock().now);
    await expect(breaker.execute(fail, counted)).rejects.toThrow();
    await breaker.execute(async () => 'ok', counted);
    await expect(breaker.execute(fail, counted)).rejects.toThrow();
    await expect(breaker.execute(fail, () => ({ counted: false }))).rejects.toThrow();
    expect(breaker.status()).toMatchObject({ state: 'closed', consecutiveFailures: 1 });
  });

  it('opens immediately until a provider rate-limit reset', async () => {
    const time = clock();
    const breaker = new CircuitBreaker('github', { failureThreshold: 5, openSeconds: 30 }, time.now);
    const reset = new Date(time.now().getTime() + 15 * 60_000);
    await expect(breaker.execute(fail, () => ({ counted: true, retryAfter: reset }))).rejects.toThrow();
    expect(breaker.status()).toMatchObject({ state: 'open', openUntil: reset });
  });
});

describe('circuit-breaking providers', () => {
  function github(overrides: Partial<GitHubProvider>): GitHubProvider {
    const unused = () => Promise.reject(new Error('not used'));
    return {
      getRepository: unused, getBranchPolicy: unused, findPullRequests: unused, createPullRequest: unused,
      getPullRequest: unused, listChecks: unused, listReviews: unused, compareCommits: unused, ...overrides,
    };
  }

  it('turns an open GitHub circuit into a transient error with the reopen time and ignores auth failures', async () => {
    const time = clock();
    const breaker = new CircuitBreaker('github', { failureThreshold: 2, openSeconds: 120 }, time.now);
    const listChecks = vi.fn().mockRejectedValue(new GitHubRequestError('GitHub GET failed (502)', 'transient', 502));
    const getRepository = vi.fn().mockRejectedValue(new GitHubRequestError('Bad credentials', 'auth', 401));
    const provider = new CircuitBreakingGitHubProvider(github({ listChecks, getRepository }), breaker);

    for (let index = 0; index < 3; index += 1) await expect(provider.getRepository('kelolakelas/web')).rejects.toMatchObject({ kind: 'auth' });
    expect(breaker.status().state).toBe('closed');

    await expect(provider.listChecks('kelolakelas/web', 'abc')).rejects.toMatchObject({ status: 502 });
    await expect(provider.listChecks('kelolakelas/web', 'abc')).rejects.toMatchObject({ status: 502 });
    const rejected = await provider.listChecks('kelolakelas/web', 'abc').catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(GitHubRequestError);
    expect(rejected).toMatchObject({ kind: 'transient', status: null, retryAfter: new Date(time.now().getTime() + 120_000) });
    expect(listChecks).toHaveBeenCalledTimes(2);
  });

  it('counts every Linear failure', async () => {
    const breaker = new CircuitBreaker('linear', { failureThreshold: 1, openSeconds: 60 }, clock().now);
    const inner = { listIssues: vi.fn().mockRejectedValue(new Error('Linear request failed: 503')), listComments: vi.fn(), createComment: vi.fn(), attachLink: vi.fn() };
    const provider = new CircuitBreakingLinearProvider(inner, breaker);
    await expect(provider.listIssues()).rejects.toThrow('503');
    await expect(provider.createComment('issue', 'body')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.createComment).not.toHaveBeenCalled();
  });
});
