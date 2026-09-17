import { CircuitOpenError, type CircuitBreaker } from './circuit-breaker.js';
import { GitHubRequestError, type GitHubProvider } from './github.js';
import type { LinearIssueWriter, LinearProvider } from './linear.js';

/**
 * GitHub provider guarded by a circuit breaker. Outages and rate limits count toward opening it; authentication,
 * rejected, and missing-resource errors are request-specific and do not. An open circuit surfaces as a transient
 * `GitHubRequestError` carrying the reopen time, which delivery stages already turn into a wait.
 */
export class CircuitBreakingGitHubProvider implements GitHubProvider {
  constructor(private readonly inner: GitHubProvider, private readonly breaker: CircuitBreaker) {}

  getRepository(...args: Parameters<GitHubProvider['getRepository']>) { return this.guard(() => this.inner.getRepository(...args)); }
  getBranchPolicy(...args: Parameters<GitHubProvider['getBranchPolicy']>) { return this.guard(() => this.inner.getBranchPolicy(...args)); }
  findPullRequests(...args: Parameters<GitHubProvider['findPullRequests']>) { return this.guard(() => this.inner.findPullRequests(...args)); }
  createPullRequest(...args: Parameters<GitHubProvider['createPullRequest']>) { return this.guard(() => this.inner.createPullRequest(...args)); }
  getPullRequest(...args: Parameters<GitHubProvider['getPullRequest']>) { return this.guard(() => this.inner.getPullRequest(...args)); }
  listChecks(...args: Parameters<GitHubProvider['listChecks']>) { return this.guard(() => this.inner.listChecks(...args)); }
  listReviews(...args: Parameters<GitHubProvider['listReviews']>) { return this.guard(() => this.inner.listReviews(...args)); }
  compareCommits(...args: Parameters<GitHubProvider['compareCommits']>) { return this.guard(() => this.inner.compareCommits(...args)); }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.execute(operation, (error) => ({
        counted: error instanceof GitHubRequestError && (error.kind === 'transient' || error.kind === 'rate-limit'),
        retryAfter: error instanceof GitHubRequestError && error.kind === 'rate-limit' ? error.retryAfter : null,
      }));
    } catch (error) {
      if (error instanceof CircuitOpenError) throw new GitHubRequestError(error.message, 'transient', null, error.retryAfter);
      throw error;
    }
  }
}

/**
 * Linear provider guarded by a circuit breaker. Every Linear failure counts, because the adapter reports transport,
 * HTTP, and GraphQL failures alike. Intake treats an open circuit as a failed poll; delivery treats it as a wait.
 */
export class CircuitBreakingLinearProvider implements LinearProvider, LinearIssueWriter {
  constructor(private readonly inner: LinearProvider & LinearIssueWriter, private readonly breaker: CircuitBreaker) {}

  listIssues() { return this.guard(() => this.inner.listIssues()); }
  listComments(...args: Parameters<LinearIssueWriter['listComments']>) { return this.guard(() => this.inner.listComments(...args)); }
  createComment(...args: Parameters<LinearIssueWriter['createComment']>) { return this.guard(() => this.inner.createComment(...args)); }
  attachLink(...args: Parameters<LinearIssueWriter['attachLink']>) { return this.guard(() => this.inner.attachLink(...args)); }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return this.breaker.execute(operation, () => ({ counted: true }));
  }
}
