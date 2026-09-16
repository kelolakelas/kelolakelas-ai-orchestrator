import type { OrchestratorConfig } from '../config/schema.js';
import { GitHubRestProvider } from '../providers/github.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CredentialCheckResult {
  credential: 'GITHUB_TOKEN' | 'LINEAR_API_KEY';
  check: string;
  status: CheckStatus;
  detail: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Classic OAuth scopes the orchestrator never needs. A fine-grained token reports no scopes header at all. */
const excessiveClassicScopes = ['admin:org', 'admin:repo_hook', 'admin:org_hook', 'delete_repo', 'workflow', 'write:packages', 'admin:enterprise', 'user', 'site_admin'];
const expiryWarningDays = 14;

/**
 * Read-only verification of orchestrator credentials, run after issuing or rotating a token and before restarting the
 * service. It proves the token reaches every registered repository's metadata, branch policy, and pull requests, and
 * flags classic tokens with broad scopes and tokens close to expiry. Write permissions cannot be proven without a side
 * effect; the credential runbook covers the scopes to grant.
 */
export async function checkCredentials(input: {
  config: OrchestratorConfig;
  githubToken: string | undefined;
  linearApiKey: string | undefined;
  request?: FetchLike;
  now?: Date;
}): Promise<CredentialCheckResult[]> {
  const request = input.request ?? fetch;
  const now = input.now ?? new Date();
  const results: CredentialCheckResult[] = [];
  const add = (credential: CredentialCheckResult['credential'], check: string, status: CheckStatus, detail: string) => results.push({ credential, check, status, detail });

  if (input.linearApiKey === undefined || input.linearApiKey === '') {
    add('LINEAR_API_KEY', 'present', 'fail', 'LINEAR_API_KEY is not set');
  } else {
    try {
      const response = await request(input.config.linear.apiUrl, {
        method: 'POST',
        headers: { authorization: input.linearApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query Check($key: String!) { viewer { id } teams(filter: { key: { eq: $key } }) { nodes { id } } }', variables: { key: input.config.linear.teamKey } }),
        signal: AbortSignal.timeout(input.config.linear.requestTimeoutMs),
      });
      const body = await response.json().catch(() => ({})) as { data?: { viewer?: { id?: string }; teams?: { nodes?: unknown[] } }; errors?: unknown[] };
      if (!response.ok || body.errors !== undefined || body.data?.viewer?.id === undefined) add('LINEAR_API_KEY', 'authenticate', 'fail', `Linear rejected the key (HTTP ${response.status})`);
      else if ((body.data.teams?.nodes ?? []).length === 0) add('LINEAR_API_KEY', 'team-access', 'fail', `The key cannot read team ${input.config.linear.teamKey}`);
      else add('LINEAR_API_KEY', 'team-access', 'pass', `Reads team ${input.config.linear.teamKey}`);
    } catch (error) {
      add('LINEAR_API_KEY', 'authenticate', 'fail', `Linear unreachable: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  const needsGitHub = input.config.orchestrator.execution.deliver || input.config.workspace?.gitAuthentication === 'github-token';
  if (input.githubToken === undefined || input.githubToken === '') {
    if (needsGitHub) add('GITHUB_TOKEN', 'present', 'fail', 'GITHUB_TOKEN is required by delivery or github-token Git authentication');
    return results;
  }
  const apiUrl = input.config.delivery?.github.apiUrl ?? 'https://api.github.com';
  try {
    const response = await request(`${apiUrl.replace(/\/$/, '')}/rate_limit`, {
      headers: { authorization: `Bearer ${input.githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'kelolakelas-ai-orchestrator' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      add('GITHUB_TOKEN', 'authenticate', 'fail', 'GitHub rejected the token');
      return results;
    }
    const scopes = response.headers.get('x-oauth-scopes');
    if (scopes !== null) {
      const excessive = scopes.split(',').map((scope) => scope.trim()).filter((scope) => excessiveClassicScopes.includes(scope));
      add('GITHUB_TOKEN', 'least-privilege', excessive.length > 0 ? 'fail' : 'warn', excessive.length > 0
        ? `Classic token with unnecessary scopes: ${excessive.join(', ')}`
        : 'Classic token; use a fine-grained token restricted to the registered repositories');
    } else {
      add('GITHUB_TOKEN', 'least-privilege', 'pass', 'Fine-grained or installation token');
    }
    const expiry = response.headers.get('github-authentication-token-expiration');
    if (expiry === null) {
      add('GITHUB_TOKEN', 'expiry', 'warn', 'Token has no expiry; set one and rotate before it lapses');
    } else {
      const days = (new Date(expiry).getTime() - now.getTime()) / 86_400_000;
      add('GITHUB_TOKEN', 'expiry', days < expiryWarningDays ? 'warn' : 'pass', `Expires ${new Date(expiry).toISOString()} (${Math.floor(days)} days)`);
    }
  } catch (error) {
    add('GITHUB_TOKEN', 'authenticate', 'fail', `GitHub unreachable: ${error instanceof Error ? error.name : 'unknown error'}`);
    return results;
  }

  const github = new GitHubRestProvider(input.config.delivery?.github ?? { apiUrl, requestTimeoutMs: 15_000, maxRetries: 1 }, input.githubToken, { request, retryBaseDelayMs: 200 });
  for (const [name, repository] of Object.entries(input.config.repositories)) {
    if (repository === undefined) continue;
    try {
      const metadata = await github.getRepository(repository.github);
      const policy = await github.getBranchPolicy(repository.github, repository.baseBranch);
      await github.findPullRequests(repository.github, 'orchestrator-credential-check');
      const checks = policy.requiredChecks.length;
      if (metadata.archived) add('GITHUB_TOKEN', `repository:${name}`, 'fail', `${repository.github} is archived`);
      else if (input.config.orchestrator.execution.deliver && metadata.canPush === false) add('GITHUB_TOKEN', `repository:${name}`, 'fail', `${repository.github} is readable but the token cannot push`);
      // Delivery blocks a base branch without required checks, so warn before enabling it.
      else add('GITHUB_TOKEN', `repository:${name}`, checks === 0 ? 'warn' : 'pass', `${repository.github} readable; ${checks} required check(s) on ${repository.baseBranch}`);
    } catch (error) {
      add('GITHUB_TOKEN', `repository:${name}`, 'fail', `${repository.github}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return results;
}
