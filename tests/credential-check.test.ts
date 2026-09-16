import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { checkCredentials } from '../src/ops/credential-check.js';
import { testConfig } from './support/config.js';

function config(overrides: Record<string, unknown> = {}) {
  const base = testConfig();
  return validateConfig({
    timezone: base.timezone,
    schedule: { days: {} },
    linear: { teamKey: 'KEL' },
    models: { ...base.models, tiers: { luna: { model: 'a' }, terra: { model: 'b' }, sol: { model: 'c' } } },
    limits: {},
    repositories: { web: { path: '/srv/web', github: 'kelolakelas/kelolakelas-web' } },
    ...overrides,
  });
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });

function fakeFetch(options: { scopes?: string; expiry?: string; push?: boolean; checks?: string[]; teams?: number; githubStatus?: number } = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const request = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });
    if (url.includes('linear')) return json({ data: { viewer: { id: 'viewer' }, teams: { nodes: Array.from({ length: options.teams ?? 1 }, () => ({ id: 't' })) } } });
    if (url.endsWith('/rate_limit')) {
      const responseHeaders: Record<string, string> = {};
      if (options.scopes !== undefined) responseHeaders['x-oauth-scopes'] = options.scopes;
      if (options.expiry !== undefined) responseHeaders['github-authentication-token-expiration'] = options.expiry;
      return json({ resources: {} }, { status: options.githubStatus ?? 200, headers: responseHeaders });
    }
    if (url.endsWith('/repos/kelolakelas/kelolakelas-web')) return json({ full_name: 'kelolakelas/kelolakelas-web', archived: false, permissions: { push: options.push ?? true } });
    if (url.includes('/rules/branches/')) return json([]);
    if (url.includes('/branches/main')) return json({ name: 'main', protected: true, protection: { required_status_checks: { contexts: options.checks ?? ['gate'] } } });
    if (url.includes('/pulls')) return json([]);
    return new Response('not found', { status: 404 });
  };
  return { request, calls };
}

describe('credential check', () => {
  const now = new Date('2026-09-17T00:00:00Z');

  it('passes a fine-grained token with expiry that reaches every repository, and a Linear key with team access', async () => {
    const { request, calls } = fakeFetch({ expiry: '2026-12-01 00:00:00 UTC' });
    const results = await checkCredentials({ config: config({ orchestrator: { execution: {} } }), githubToken: 'github_pat_secret', linearApiKey: 'lin_api_secret', request, now });
    expect(results.map(({ check, status, detail }) => `${check}:${status}${status === 'fail' ? ` ${detail}` : ''}`)).toEqual(['team-access:pass', 'least-privilege:pass', 'expiry:pass', 'repository:web:pass']);
    expect(JSON.stringify(results)).not.toMatch(/github_pat_secret|lin_api_secret/);
    expect(calls.every((call) => call.url.startsWith('https://api.github.com/') || call.url.startsWith('https://api.linear.app/'))).toBe(true);
  });

  it('fails classic tokens with broad scopes, rejected keys, and missing push access, and warns on expiry and missing checks', async () => {
    const { request } = fakeFetch({ scopes: 'repo, workflow, admin:org', expiry: '2026-09-20 00:00:00 UTC', push: false, checks: [], teams: 0 });
    const deliver = config({
      orchestrator: { execution: { prepareWorkspaces: true, runAgents: true, deliver: true } },
      workspace: { root: '/var/lib/ai-orchestrator/workspaces' },
      repositories: { web: { path: '/srv/web', github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }] } } },
      agents: { runner: { executable: '/usr/bin/codex' }, commitAuthor: { name: 'Bot', email: 'bot@example.test' } },
      delivery: {},
    });
    const results = await checkCredentials({ config: { ...deliver, models: { ...deliver.models } }, githubToken: 'ghp_x', linearApiKey: 'lin_api_x', request, now });
    expect(results.map(({ check, status }) => `${check}:${status}`)).toEqual(['team-access:fail', 'least-privilege:fail', 'expiry:warn', 'repository:web:fail']);
    expect(results.find((result) => result.check === 'least-privilege')?.detail).toContain('workflow, admin:org');
  });

  it('fails when a required credential is missing or rejected', async () => {
    const withToken = config({ workspace: { root: '/var/lib/ai-orchestrator/workspaces', gitAuthentication: 'github-token' } });
    expect((await checkCredentials({ config: withToken, githubToken: undefined, linearApiKey: undefined, request: fakeFetch().request, now })).map((result) => result.status)).toEqual(['fail', 'fail']);
    const rejected = await checkCredentials({ config: withToken, githubToken: 'bad', linearApiKey: 'lin', request: fakeFetch({ githubStatus: 401 }).request, now });
    expect(rejected.at(-1)).toMatchObject({ check: 'authenticate', status: 'fail' });
  });
});
