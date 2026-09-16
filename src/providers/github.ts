import { z } from 'zod';
import type { DeliveryConfig } from '../config/schema.js';

export interface GitHubRepository {
  /** Lowercase `owner/name`. */
  fullName: string;
  archived: boolean;
  /** Null when GitHub does not report permissions, as for GitHub App installation tokens. */
  canPush: boolean | null;
}

export interface RequiredCheck {
  context: string;
  /** GitHub App that must report the check, when the policy pins one. */
  appId: number | null;
  source: 'branch-protection' | 'ruleset';
}

/** Merge policy of a base branch, read from GitHub on every observation rather than from issue content. */
export interface BranchPolicy {
  protected: boolean;
  requiredChecks: RequiredCheck[];
  /** From rulesets; classic branch protection does not expose the count without administration access. */
  requiredApprovingReviews: number | null;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  /** Lowercase `owner/name` of the head repository; null when the fork was deleted. */
  headRepository: string | null;
  baseRef: string;
  draft: boolean;
  /** GitHub's computed mergeability, for example `clean`, `blocked`, `behind`, `dirty`, or `unknown`. */
  mergeableState: string | null;
  body: string;
}

export interface CheckResult {
  name: string;
  kind: 'check-run' | 'status';
  /** Check runs: `queued`, `in_progress`, `completed`, ... Statuses: `pending` or `completed`. */
  status: string;
  /** Check runs: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, ... Statuses: `success`, `failure`, `error`. */
  conclusion: string | null;
  appId: number | null;
  updatedAt: string | null;
}

export interface PullRequestReview {
  reviewer: string | null;
  state: string;
  commitId: string | null;
  submittedAt: string | null;
}

export type CommitComparison = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

/**
 * GitHub operations used by delivery. Repositories are `owner/name` values from the trusted registry. Implementations
 * validate every response, and reads may be retried; `createPullRequest` is never retried because its outcome can be
 * ambiguous, so callers reconcile through `findPullRequests`.
 */
export interface GitHubProvider {
  getRepository(repository: string): Promise<GitHubRepository>;
  getBranchPolicy(repository: string, branch: string): Promise<BranchPolicy>;
  /** Every pull request, open or closed, whose head is `branch` in the same repository. */
  findPullRequests(repository: string, branch: string): Promise<GitHubPullRequest[]>;
  createPullRequest(repository: string, input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  getPullRequest(repository: string, number: number): Promise<GitHubPullRequest>;
  listChecks(repository: string, sha: string): Promise<CheckResult[]>;
  listReviews(repository: string, number: number): Promise<PullRequestReview[]>;
  /** How `head` relates to `base`: `ahead` or `identical` means `head` contains `base`. */
  compareCommits(repository: string, base: string, head: string): Promise<CommitComparison>;
}

export type GitHubErrorKind = 'transient' | 'rate-limit' | 'auth' | 'not-found' | 'rejected' | 'invalid-response';

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: GitHubErrorKind,
    public readonly status: number | null,
    public readonly retryAfter: Date | null = null,
  ) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  mergeable_state: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() }),
});

const repositorySchema = z.object({
  full_name: z.string(),
  archived: z.boolean(),
  permissions: z.object({ push: z.boolean() }).partial().optional(),
});

const branchSchema = z.object({
  protected: z.boolean(),
  protection: z.object({
    required_status_checks: z.object({
      contexts: z.array(z.string()).optional(),
      checks: z.array(z.object({ context: z.string(), app_id: z.number().int().nullable().optional() })).optional(),
    }).nullable().optional(),
  }).optional(),
});

const rulesSchema = z.array(z.object({
  type: z.string(),
  parameters: z.object({
    required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number().int().nullable().optional() })).optional(),
    required_approving_review_count: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}));

const checkRunsSchema = z.object({
  check_runs: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    completed_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    app: z.object({ id: z.number().int() }).nullable().optional(),
  })),
});

const combinedStatusSchema = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.enum(['error', 'failure', 'pending', 'success']), updated_at: z.string().nullable().optional() })),
});

const reviewsSchema = z.array(z.object({
  user: z.object({ login: z.string() }).nullable().optional(),
  state: z.string(),
  commit_id: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
}));

const compareSchema = z.object({ status: z.enum(['ahead', 'behind', 'identical', 'diverged']) });

function toPullRequest(input: z.infer<typeof pullRequestSchema>): GitHubPullRequest {
  return {
    number: input.number,
    url: input.html_url,
    state: input.state,
    merged: input.merged === true || (input.merged_at !== null && input.merged_at !== undefined),
    mergeCommitSha: input.merge_commit_sha ?? null,
    headSha: input.head.sha,
    headRef: input.head.ref,
    headRepository: input.head.repo?.full_name.toLowerCase() ?? null,
    baseRef: input.base.ref,
    draft: input.draft ?? false,
    mergeableState: input.mergeable_state ?? null,
    body: input.body ?? '',
  };
}

function repositoryPath(repository: string): string {
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra !== undefined) throw new GitHubRequestError(`Invalid repository ${repository}`, 'rejected', null);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function arrayPage(page: unknown): unknown[] {
  if (!Array.isArray(page)) throw new GitHubRequestError('GitHub response page was not a list', 'invalid-response', null);
  return page;
}

/** Parses the `next` URL from a `Link` header. */
export function nextPageUrl(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * GitHub REST adapter authenticated with a token from the service environment. Pagination only follows links on the
 * configured API origin, so the token is never sent elsewhere.
 */
export class GitHubRestProvider implements GitHubProvider {
  private readonly apiBase: URL;

  constructor(
    private readonly config: DeliveryConfig['github'],
    private readonly token: string,
    private readonly options: { request?: FetchLike; now?: () => Date; retryBaseDelayMs?: number } = {},
  ) {
    this.apiBase = new URL(config.apiUrl.endsWith('/') ? config.apiUrl : `${config.apiUrl}/`);
  }

  async getRepository(repository: string): Promise<GitHubRepository> {
    const body = repositorySchema.parse(await this.json('GET', repositoryPath(repository)));
    return { fullName: body.full_name.toLowerCase(), archived: body.archived, canPush: body.permissions?.push ?? null };
  }

  async getBranchPolicy(repository: string, branch: string): Promise<BranchPolicy> {
    const base = repositoryPath(repository);
    const branchBody = this.parse(branchSchema, await this.json('GET', `${base}/branches/${encodeURIComponent(branch)}`));
    const requiredChecks: RequiredCheck[] = [];
    const statusChecks = branchBody.protection?.required_status_checks;
    if (statusChecks?.checks !== undefined) {
      requiredChecks.push(...statusChecks.checks.map((check) => ({ context: check.context, appId: check.app_id ?? null, source: 'branch-protection' as const })));
    } else if (statusChecks?.contexts !== undefined) {
      requiredChecks.push(...statusChecks.contexts.map((context) => ({ context, appId: null, source: 'branch-protection' as const })));
    }

    let requiredApprovingReviews: number | null = null;
    let rules: z.infer<typeof rulesSchema> = [];
    try {
      rules = this.parse(rulesSchema, await this.paginate(`${base}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, arrayPage));
    } catch (error) {
      // Repositories without rulesets support answer 404; the classic protection above still applies.
      if (!(error instanceof GitHubRequestError && error.kind === 'not-found')) throw error;
    }
    for (const rule of rules) {
      if (rule.type === 'required_status_checks') {
        for (const check of rule.parameters?.required_status_checks ?? []) {
          requiredChecks.push({ context: check.context, appId: check.integration_id ?? null, source: 'ruleset' });
        }
      }
      if (rule.type === 'pull_request' && rule.parameters?.required_approving_review_count !== undefined) {
        requiredApprovingReviews = Math.max(requiredApprovingReviews ?? 0, rule.parameters.required_approving_review_count);
      }
    }
    return { protected: branchBody.protected || rules.length > 0, requiredChecks, requiredApprovingReviews };
  }

  async findPullRequests(repository: string, branch: string): Promise<GitHubPullRequest[]> {
    const owner = repository.split('/')[0] ?? '';
    const query = new URLSearchParams({ state: 'all', head: `${owner}:${branch}`, per_page: '100' });
    const items = await this.paginate(`${repositoryPath(repository)}/pulls?${query.toString()}`, arrayPage);
    return this.parse(z.array(pullRequestSchema), items)
      .map(toPullRequest)
      // The head filter matches by name; only pull requests from the registered repository itself are ours.
      .filter((pullRequest) => pullRequest.headRef === branch && pullRequest.headRepository === repository.toLowerCase());
  }

  async createPullRequest(repository: string, input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const body = await this.json('POST', `${repositoryPath(repository)}/pulls`, {
      title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft, maintainer_can_modify: false,
    });
    return toPullRequest(this.parse(pullRequestSchema, body));
  }

  async getPullRequest(repository: string, number: number): Promise<GitHubPullRequest> {
    return toPullRequest(this.parse(pullRequestSchema, await this.json('GET', `${repositoryPath(repository)}/pulls/${number}`)));
  }

  async listChecks(repository: string, sha: string): Promise<CheckResult[]> {
    const base = repositoryPath(repository);
    const commit = encodeURIComponent(sha);
    const runs = await this.paginate(`${base}/commits/${commit}/check-runs?filter=latest&per_page=100`, (page) => this.parse(checkRunsSchema, page).check_runs);
    const statuses = await this.paginate(`${base}/commits/${commit}/status?per_page=100`, (page) => this.parse(combinedStatusSchema, page).statuses);
    return [
      ...runs.map((run) => ({
        name: run.name, kind: 'check-run' as const, status: run.status, conclusion: run.conclusion, appId: run.app?.id ?? null,
        updatedAt: run.completed_at ?? run.started_at ?? null,
      })),
      ...statuses.map((status) => ({
        name: status.context, kind: 'status' as const, status: status.state === 'pending' ? 'pending' : 'completed',
        conclusion: status.state === 'pending' ? null : status.state, appId: null, updatedAt: status.updated_at ?? null,
      })),
    ];
  }

  async listReviews(repository: string, number: number): Promise<PullRequestReview[]> {
    const items = await this.paginate(`${repositoryPath(repository)}/pulls/${number}/reviews?per_page=100`, arrayPage);
    return this.parse(reviewsSchema, items).map((review) => ({
      reviewer: review.user?.login ?? null, state: review.state, commitId: review.commit_id ?? null, submittedAt: review.submitted_at ?? null,
    }));
  }

  async compareCommits(repository: string, base: string, head: string): Promise<CommitComparison> {
    const body = await this.json('GET', `${repositoryPath(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`);
    return this.parse(compareSchema, body).status;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new GitHubRequestError(`GitHub response did not match the expected shape: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`, 'invalid-response', null);
    }
    return parsed.data;
  }

  private async paginate<T>(path: string, items: (page: unknown) => T[]): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = this.resolve(path);
    for (let page = 0; url !== null; page += 1) {
      if (page >= 50) throw new GitHubRequestError('GitHub pagination exceeded 50 pages', 'invalid-response', null);
      const response = await this.send('GET', url);
      results.push(...items(await this.body(response)));
      const next = nextPageUrl(response.headers.get('link'));
      if (next !== null && !this.sameApi(next)) throw new GitHubRequestError('GitHub pagination link left the configured API origin', 'invalid-response', null);
      url = next;
    }
    return results;
  }

  private async json(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    return this.body(await this.send(method, this.resolve(path), payload));
  }

  private resolve(path: string): string {
    return new URL(path.replace(/^\//, ''), this.apiBase).toString();
  }

  private sameApi(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.origin === this.apiBase.origin && parsed.pathname.startsWith(this.apiBase.pathname);
    } catch {
      return false;
    }
  }

  private async body(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GitHubRequestError('GitHub response was not JSON', 'invalid-response', response.status);
    }
  }

  private async send(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Response> {
    // Only reads are retried. A write whose response was lost may have taken effect; the caller reconciles instead.
    const attempts = method === 'GET' ? this.config.maxRetries + 1 : 1;
    let lastError: GitHubRequestError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, (this.options.retryBaseDelayMs ?? 1_000) * 2 ** (attempt - 1)));
      try {
        const response = await (this.options.request ?? fetch)(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.token}`,
            'user-agent': 'kelolakelas-ai-orchestrator',
            'x-github-api-version': '2022-11-28',
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          redirect: 'error',
        });
        if (response.ok) return response;
        lastError = await this.classify(response, method, url);
      } catch (error) {
        if (error instanceof GitHubRequestError) throw error;
        lastError = new GitHubRequestError(`GitHub ${method} request failed: ${error instanceof Error ? error.name : 'unknown error'}`, 'transient', null);
      }
      if (lastError.kind !== 'transient') throw lastError;
    }
    throw lastError ?? new GitHubRequestError('GitHub request failed', 'transient', null);
  }

  private async classify(response: Response, method: string, url: string): Promise<GitHubRequestError> {
    const now = this.options.now?.() ?? new Date();
    let message = '';
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === 'string') message = body.message.slice(0, 300);
    } catch {
      // Non-JSON error body.
    }
    const endpoint = `${method} ${new URL(url).pathname}`;
    const detail = `GitHub ${endpoint} failed (${response.status})${message ? `: ${message}` : ''}`;
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
    if (response.status === 429 || (response.status === 403 && (exhausted || (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) || /rate limit/i.test(message)))) {
      const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? new Date(now.getTime() + retryAfterSeconds * 1_000)
        : Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1_000) : null;
      return new GitHubRequestError(detail, 'rate-limit', response.status, retryAfter);
    }
    if (response.status === 401 || response.status === 403) return new GitHubRequestError(detail, 'auth', response.status);
    if (response.status === 404) return new GitHubRequestError(detail, 'not-found', response.status);
    if (response.status >= 500 || response.status === 408) return new GitHubRequestError(detail, 'transient', response.status);
    return new GitHubRequestError(detail, 'rejected', response.status);
  }
}
