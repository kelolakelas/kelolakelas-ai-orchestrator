import { describe, expect, it } from 'vitest';
import { GitHubRestProvider, nextPageUrl, type GitHubRequestError } from '../src/providers/github.js';

const config = { apiUrl: 'https://api.github.test', requestTimeoutMs: 1_000, maxRetries: 2 };
const now = new Date('2026-09-16T10:00:00.000Z');
const sha = 'a'.repeat(40);

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function provider(route: Route) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const instance = new GitHubRestProvider(config, 'ghs_secret-token', {
    now: () => now,
    retryBaseDelayMs: 0,
    request: async (input, init = {}) => {
      requests.push({ method: init.method ?? 'GET', url: input, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return route(new URL(input), init);
    },
  });
  return { instance, requests };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7, html_url: 'https://github.com/kelolakelas/kelolakelas-web/pull/7', state: 'open', merged: false, merge_commit_sha: null, draft: false,
  mergeable_state: 'blocked', body: 'body', head: { sha, ref: 'kel-1-feature', repo: { full_name: 'kelolakelas/kelolakelas-web' } }, base: { ref: 'main' },
  ...overrides,
});

describe('GitHub REST provider', () => {
  it('authenticates every request and derives required checks from branch protection and rulesets', async () => {
    const { instance, requests } = provider((url) => {
      if (!url.pathname.includes('/rules/')) {
        return json({ protected: true, protection: { enabled: true, required_status_checks: { contexts: ['gate'], checks: [{ context: 'gate', app_id: 15368 }] } } });
      }
      return json([
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'security', integration_id: 42 }] } },
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        { type: 'non_fast_forward' },
      ]);
    });
    expect(await instance.getBranchPolicy('kelolakelas/kelolakelas-web', 'main')).toEqual({
      protected: true,
      requiredChecks: [{ context: 'gate', appId: 15368, source: 'branch-protection' }, { context: 'security', appId: 42, source: 'ruleset' }],
      requiredApprovingReviews: 1,
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.github.test/repos/kelolakelas/kelolakelas-web/branches/main',
      'https://api.github.test/repos/kelolakelas/kelolakelas-web/rules/branches/main?per_page=100',
    ]);
    expect(requests[0]?.headers).toMatchObject({ authorization: 'Bearer ghs_secret-token', 'x-github-api-version': '2022-11-28' });
  });

  it('treats repositories without rulesets as protection-only and unprotected branches as having no required checks', async () => {
    const { instance } = provider((url) => url.pathname.includes('/rules/') ? json({ message: 'Not Found' }, { status: 404 }) : json({ protected: false }));
    expect(await instance.getBranchPolicy('kelolakelas/kelolakelas-web', 'main')).toEqual({ protected: false, requiredChecks: [], requiredApprovingReviews: null });
  });

  it('follows pagination only on the configured API origin', async () => {
    const pages = provider((url) => url.searchParams.get('page') === '2'
      ? json({ check_runs: [{ name: 'test', status: 'queued', conclusion: null, app: { id: 1 } }] })
      : url.pathname.endsWith('/status')
        ? json({ statuses: [{ context: 'legacy', state: 'failure', updated_at: '2026-09-16T00:00:00Z' }] })
        : json({ check_runs: [{ name: 'gate', status: 'completed', conclusion: 'success', app: { id: 15368 }, completed_at: '2026-09-16T00:00:00Z' }] }, { headers: { link: `<${config.apiUrl}/repos/o/r/commits/${sha}/check-runs?page=2>; rel="next", <${config.apiUrl}/x?page=9>; rel="last"` } }));
    expect(await pages.instance.listChecks('o/r', sha)).toEqual([
      { name: 'gate', kind: 'check-run', status: 'completed', conclusion: 'success', appId: 15368, updatedAt: '2026-09-16T00:00:00Z' },
      { name: 'test', kind: 'check-run', status: 'queued', conclusion: null, appId: 1, updatedAt: null },
      { name: 'legacy', kind: 'status', status: 'completed', conclusion: 'failure', appId: null, updatedAt: '2026-09-16T00:00:00Z' },
    ]);

    const leaking = provider(() => json([], { headers: { link: '<https://attacker.example/steal?page=2>; rel="next"' } }));
    await expect(leaking.instance.listReviews('o/r', 1)).rejects.toMatchObject({ kind: 'invalid-response', message: expect.stringContaining('left the configured API origin') });
    expect(leaking.requests.map((request) => new URL(request.url).host)).toEqual(['api.github.test']);
    expect(nextPageUrl('<https://a/1>; rel="prev", <https://a/3>; rel="next"')).toBe('https://a/3');
  });

  it('finds only pull requests from the same repository and branch', async () => {
    const { instance, requests } = provider(() => json([
      pull(),
      pull({ number: 8, head: { sha, ref: 'kel-1-feature', repo: { full_name: 'someone/fork' } } }),
      pull({ number: 9, state: 'closed', merged_at: '2026-09-16T00:00:00Z', merge_commit_sha: 'b'.repeat(40) }),
    ]));
    const found = await instance.findPullRequests('kelolakelas/kelolakelas-web', 'kel-1-feature');
    expect(found.map((entry) => [entry.number, entry.merged, entry.mergeCommitSha])).toEqual([[7, false, null], [9, true, 'b'.repeat(40)]]);
    expect(new URL(requests[0]!.url).searchParams.get('head')).toBe('kelolakelas:kel-1-feature');
    expect(new URL(requests[0]!.url).searchParams.get('state')).toBe('all');
  });

  it('retries transient reads but never retries a pull request creation', async () => {
    let reads = 0;
    const flaky = provider(() => (reads += 1) < 3 ? new Response('bad gateway', { status: 502 }) : json(pull()));
    expect((await flaky.instance.getPullRequest('kelolakelas/kelolakelas-web', 7)).number).toBe(7);
    expect(reads).toBe(3);

    let writes = 0;
    const failing = provider(() => { writes += 1; return new Response('', { status: 502 }); });
    await expect(failing.instance.createPullRequest('kelolakelas/kelolakelas-web', { title: 't', head: 'kel-1-feature', base: 'main', body: 'b', draft: false }))
      .rejects.toMatchObject({ kind: 'transient', status: 502 });
    expect(writes).toBe(1);
    expect(failing.requests[0]?.body).toEqual({ title: 't', head: 'kel-1-feature', base: 'main', body: 'b', draft: false, maintainer_can_modify: false });

    const offline = provider(() => { throw new TypeError('fetch failed'); });
    await expect(offline.instance.getRepository('o/r')).rejects.toMatchObject({ kind: 'transient' });
    expect(offline.requests).toHaveLength(3);
  });

  it('classifies rate limits, authentication failures, rejections, and malformed responses', async () => {
    const limited = provider(() => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now.getTime() / 1_000 + 900) } }));
    const rateLimit = await limited.instance.getRepository('o/r').catch((error: unknown) => error) as GitHubRequestError;
    expect(rateLimit).toMatchObject({ kind: 'rate-limit', status: 403, retryAfter: new Date(now.getTime() + 900_000) });
    expect(limited.requests).toHaveLength(1);

    const secondary = provider(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(secondary.instance.getRepository('o/r')).rejects.toMatchObject({ kind: 'rate-limit', retryAfter: new Date(now.getTime() + 60_000) });

    await expect(provider(() => json({ message: 'Bad credentials' }, { status: 401 })).instance.getRepository('o/r')).rejects.toMatchObject({ kind: 'auth' });
    await expect(provider(() => json({ message: 'Resource not accessible' }, { status: 403 })).instance.getRepository('o/r')).rejects.toMatchObject({ kind: 'auth' });
    await expect(provider(() => json({ message: 'Validation Failed' }, { status: 422 })).instance.createPullRequest('o/r', { title: 't', head: 'h', base: 'main', body: '', draft: false }))
      .rejects.toMatchObject({ kind: 'rejected', status: 422, message: expect.stringContaining('Validation Failed') });
    await expect(provider(() => json({ ...pull(), head: { sha: 'not-a-sha', ref: 'x', repo: null } })).instance.getPullRequest('o/r', 7)).rejects.toMatchObject({ kind: 'invalid-response' });
    await expect(provider(() => json({ message: 'not a list' })).instance.listReviews('o/r', 7)).rejects.toMatchObject({ kind: 'invalid-response' });
    const unknown = await provider(() => json({ message: 'x' }, { status: 401 })).instance.getRepository('o/r').catch((error: unknown) => error) as Error;
    expect(unknown.message).not.toContain('ghs_secret-token');
  });

  it('reports repository permissions and commit relations', async () => {
    const { instance, requests } = provider((url) => url.pathname.includes('/compare/')
      ? json({ status: 'ahead', ahead_by: 2 })
      : json({ full_name: 'KelolaKelas/KelolaKelas-Web', archived: false, permissions: { admin: false, push: true } }));
    expect(await instance.getRepository('kelolakelas/kelolakelas-web')).toEqual({ fullName: 'kelolakelas/kelolakelas-web', archived: false, canPush: true });
    expect(await instance.compareCommits('kelolakelas/kelolakelas-web', sha, 'main')).toBe('ahead');
    const installation = provider(() => json({ full_name: 'o/r', archived: true }));
    expect(await installation.instance.getRepository('o/r')).toEqual({ fullName: 'o/r', archived: true, canPush: null });
    expect(requests[1]?.url).toBe(`https://api.github.test/repos/kelolakelas/kelolakelas-web/compare/${sha}...main?per_page=1`);
  });
});
