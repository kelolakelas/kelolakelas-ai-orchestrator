import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubRequestError, type BranchPolicy, type CheckResult, type CommitComparison, type CreatePullRequestInput, type GitHubProvider,
  type GitHubPullRequest, type GitHubRepository, type PullRequestReview,
} from '../../src/providers/github.js';
import type { LinearComment, LinearIssueWriter } from '../../src/providers/linear.js';
import type { RepositoryName } from '../../src/workspaces/repository-registry.js';
import type { GitFixture } from './git-fixture.js';

const identity = ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.test', '-c', 'commit.gpgsign=false'];

function gitIn(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** When an injected failure happens relative to the side effect. */
export type Injection = { when: 'before' | 'after'; error: () => Error };

interface StoredPullRequest {
  number: number;
  repository: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  frozenHead: string | null;
  mergeableState: string | null;
}

/**
 * GitHub stand-in whose pull requests read branch heads from the fixture's bare remotes, so pushes, merges, force-pushes,
 * and reachability are real Git. Checks, reviews, and policies are set by tests. Failures can be injected before or
 * after a method's effect to simulate lost responses and crashes.
 */
export class FakeGitHub implements GitHubProvider {
  readonly calls: string[] = [];
  readonly pullRequests: StoredPullRequest[] = [];
  private readonly checks = new Map<string, CheckResult[]>();
  private readonly reviews = new Map<string, PullRequestReview[]>();
  private readonly policies = new Map<string, BranchPolicy>();
  private readonly injections = new Map<string, Injection[]>();

  constructor(private readonly fixture: GitFixture) {}

  static gateApp = 15368;

  inject(method: keyof GitHubProvider, injection: Injection): void {
    this.injections.set(method, [...(this.injections.get(method) ?? []), injection]);
  }

  setPolicy(repository: string, policy: BranchPolicy): void {
    this.policies.set(repository, policy);
  }

  setCheck(repository: string, sha: string, conclusion: string | null, name = 'gate', appId: number | null = FakeGitHub.gateApp): void {
    const key = `${repository}@${sha}`;
    const others = (this.checks.get(key) ?? []).filter((check) => check.name !== name || check.appId !== appId);
    this.checks.set(key, [...others, { name, kind: 'check-run', status: conclusion === null ? 'in_progress' : 'completed', conclusion, appId, updatedAt: null }]);
  }

  addReview(repository: string, number: number, review: PullRequestReview): void {
    const key = `${repository}#${number}`;
    this.reviews.set(key, [...(this.reviews.get(key) ?? []), review]);
  }

  bare(repository: string): string {
    return this.fixture.bare(repository.replace('kelolakelas/kelolakelas-', '') as RepositoryName);
  }

  branchHead(repository: string, branch: string): string | null {
    const result = gitIn(this.bare(repository), 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`);
    return result.ok ? result.stdout : null;
  }

  find(repository: string, number: number): StoredPullRequest {
    const stored = this.pullRequests.find((entry) => entry.repository === repository && entry.number === number);
    if (!stored) throw new Error(`No pull request ${repository}#${number}`);
    return stored;
  }

  /** Merges with a real merge commit on the remote base branch, like the GitHub merge button. */
  merge(repository: string, number: number): string {
    const stored = this.find(repository, number);
    const scratch = mkdtempSync(join(tmpdir(), 'fake-github-merge-'));
    try {
      gitIn(tmpdir(), 'clone', '-q', this.bare(repository), scratch);
      const merged = gitIn(scratch, 'merge', '--no-ff', '-q', '-m', `Merge pull request #${number}`, `origin/${stored.headRef}`);
      if (!merged.ok) throw new Error('merge failed');
      gitIn(scratch, 'push', '-q', 'origin', stored.baseRef);
      stored.frozenHead = this.branchHead(repository, stored.headRef);
      stored.mergeCommitSha = gitIn(scratch, 'rev-parse', 'HEAD').stdout;
      stored.merged = true;
      stored.state = 'closed';
      return stored.mergeCommitSha;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Reports a pull request as merged with a merge commit that the base branch does not contain. */
  markMergedOutsideBase(repository: string, number: number): string {
    const stored = this.find(repository, number);
    stored.frozenHead = this.branchHead(repository, stored.headRef);
    stored.mergeCommitSha = stored.frozenHead;
    stored.merged = true;
    stored.state = 'closed';
    return stored.mergeCommitSha!;
  }

  /** Adds a commit on top of the pull request branch, like "Update branch" or a reviewer's fix. */
  advanceBranch(repository: string, branch: string, file: string): string {
    return this.rewriteBranch(repository, branch, file, false);
  }

  /** Replaces the pull request branch with unrelated history, like a force-push. */
  forcePush(repository: string, branch: string, file: string): string {
    return this.rewriteBranch(repository, branch, file, true);
  }

  close(repository: string, number: number): void {
    const stored = this.find(repository, number);
    stored.state = 'closed';
    stored.frozenHead = this.branchHead(repository, stored.headRef);
  }

  async getRepository(repository: string): Promise<GitHubRepository> {
    await this.enter('getRepository', 'before');
    return { fullName: repository, archived: false, canPush: true };
  }

  async getBranchPolicy(repository: string): Promise<BranchPolicy> {
    await this.enter('getBranchPolicy', 'before');
    return this.policies.get(repository) ?? { protected: true, requiredChecks: [{ context: 'gate', appId: FakeGitHub.gateApp, source: 'branch-protection' }], requiredApprovingReviews: null };
  }

  async findPullRequests(repository: string, branch: string): Promise<GitHubPullRequest[]> {
    await this.enter('findPullRequests', 'before');
    const found = this.pullRequests.filter((entry) => entry.repository === repository && entry.headRef === branch).map((entry) => this.view(entry));
    await this.enter('findPullRequests', 'after');
    return found;
  }

  async createPullRequest(repository: string, input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    await this.enter('createPullRequest', 'before');
    if (this.pullRequests.some((entry) => entry.repository === repository && entry.headRef === input.head && entry.baseRef === input.base && entry.state === 'open')) {
      throw new GitHubRequestError(`GitHub POST /repos/${repository}/pulls failed (422): A pull request already exists for ${input.head}.`, 'rejected', 422);
    }
    if (this.branchHead(repository, input.head) === null) throw new GitHubRequestError('head branch missing', 'rejected', 422);
    const stored: StoredPullRequest = {
      number: this.pullRequests.filter((entry) => entry.repository === repository).length + 1,
      repository, headRef: input.head, baseRef: input.base, title: input.title, body: input.body, draft: input.draft,
      state: 'open', merged: false, mergeCommitSha: null, frozenHead: null, mergeableState: 'blocked',
    };
    this.pullRequests.push(stored);
    await this.enter('createPullRequest', 'after');
    return this.view(stored);
  }

  async getPullRequest(repository: string, number: number): Promise<GitHubPullRequest> {
    await this.enter('getPullRequest', 'before');
    return this.view(this.find(repository, number));
  }

  async listChecks(repository: string, sha: string): Promise<CheckResult[]> {
    await this.enter('listChecks', 'before');
    return this.checks.get(`${repository}@${sha}`) ?? [];
  }

  async listReviews(repository: string, number: number): Promise<PullRequestReview[]> {
    await this.enter('listReviews', 'before');
    return this.reviews.get(`${repository}#${number}`) ?? [];
  }

  async compareCommits(repository: string, base: string, head: string): Promise<CommitComparison> {
    await this.enter('compareCommits', 'before');
    const bare = this.bare(repository);
    const resolve = (ref: string) => gitIn(bare, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    const baseSha = resolve(base);
    const headSha = resolve(head);
    if (!baseSha.ok || !headSha.ok) throw new GitHubRequestError('No common ancestor', 'not-found', 404);
    if (baseSha.stdout === headSha.stdout) return 'identical';
    if (gitIn(bare, 'merge-base', '--is-ancestor', baseSha.stdout, headSha.stdout).ok) return 'ahead';
    if (gitIn(bare, 'merge-base', '--is-ancestor', headSha.stdout, baseSha.stdout).ok) return 'behind';
    return 'diverged';
  }

  private view(stored: StoredPullRequest): GitHubPullRequest {
    const head = stored.frozenHead ?? this.branchHead(stored.repository, stored.headRef);
    if (head === null) throw new Error(`Head branch ${stored.headRef} is missing`);
    return {
      number: stored.number, url: `https://github.com/${stored.repository}/pull/${stored.number}`, state: stored.state, merged: stored.merged,
      mergeCommitSha: stored.mergeCommitSha, headSha: head, headRef: stored.headRef, headRepository: stored.repository, baseRef: stored.baseRef,
      draft: stored.draft, mergeableState: stored.mergeableState, body: stored.body,
    };
  }

  private async enter(method: string, when: 'before' | 'after'): Promise<void> {
    if (when === 'before') this.calls.push(method);
    const queue = this.injections.get(method) ?? [];
    const index = queue.findIndex((injection) => injection.when === when);
    if (index === -1) return;
    const [injection] = queue.splice(index, 1);
    throw injection!.error();
  }

  private rewriteBranch(repository: string, branch: string, file: string, unrelated: boolean): string {
    const scratch = mkdtempSync(join(tmpdir(), 'fake-github-push-'));
    try {
      gitIn(tmpdir(), 'clone', '-q', this.bare(repository), scratch);
      gitIn(scratch, 'checkout', '-q', unrelated ? 'main' : branch);
      if (unrelated) gitIn(scratch, 'checkout', '-q', '-B', branch);
      writeFileSync(join(scratch, file), `${file}\n`);
      gitIn(scratch, 'add', '.');
      gitIn(scratch, 'commit', '-q', '-m', `edit ${file}`);
      gitIn(scratch, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`);
      return gitIn(scratch, 'rev-parse', 'HEAD').stdout;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Linear stand-in that stores comments and attachments per issue and supports failure injection. */
export class FakeLinear implements LinearIssueWriter {
  readonly comments = new Map<string, LinearComment[]>();
  readonly attachments = new Map<string, Array<{ url: string; title: string; subtitle: string }>>();
  private readonly injections = new Map<string, Injection[]>();

  inject(method: keyof LinearIssueWriter, injection: Injection): void {
    this.injections.set(method, [...(this.injections.get(method) ?? []), injection]);
  }

  commentsFor(issueId: string): string[] {
    return (this.comments.get(issueId) ?? []).map((comment) => comment.body);
  }

  async listComments(issueId: string): Promise<LinearComment[]> {
    this.enter('listComments', 'before');
    return [...(this.comments.get(issueId) ?? [])];
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    this.enter('createComment', 'before');
    const comments = this.comments.get(issueId) ?? [];
    const comment = { id: `comment-${comments.length + 1}`, body };
    this.comments.set(issueId, [...comments, comment]);
    this.enter('createComment', 'after');
    return { id: comment.id };
  }

  async attachLink(issueId: string, input: { url: string; title: string; subtitle: string }): Promise<{ id: string }> {
    this.enter('attachLink', 'before');
    const existing = (this.attachments.get(issueId) ?? []).filter((attachment) => attachment.url !== input.url);
    this.attachments.set(issueId, [...existing, input]);
    return { id: `attachment-${input.url}` };
  }

  private enter(method: string, when: 'before' | 'after'): void {
    const queue = this.injections.get(method) ?? [];
    const index = queue.findIndex((injection) => injection.when === when);
    if (index === -1) return;
    const [injection] = queue.splice(index, 1);
    throw injection!.error();
  }
}
