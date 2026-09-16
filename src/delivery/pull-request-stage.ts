import type { PlanningIssue } from '../intake/planning-contract.js';
import { evaluateChanges, describeViolations } from '../execution/diff-policy.js';
import {
  checkpointKeys, completeAttempt, loadTaskWorkspaces, qualityPassedSchema, readCheckpoint, reviewApprovedSchema, sameHeads, startAttempt,
  type LoadedWorkspaces,
} from '../execution/stages/stage-support.js';
import type { StageContext, StageHandler, StageOutcome } from '../orchestrator/stage-handler.js';
import { GitHubRequestError, type GitHubPullRequest } from '../providers/github.js';
import type { PersistedTask } from '../repositories/task.repository.js';
import type { RegisteredRepository } from '../workspaces/repository-registry.js';
import {
  classifyDeliveryError, idempotentOperation, manualDeliveryIntervention, shortSha, syncLinearComment, syncLinearPullRequestLink, untrustedText,
  notifyLinearBestEffort, type DeliveryDependencies,
} from './delivery-support.js';

type Unit = LoadedWorkspaces['units'][number];

/** Diff-policy rules that describe content safety rather than the size of one agent attempt. */
const cumulativeRules = new Set(['forbidden-path', 'generated-path', 'symlink', 'submodule', 'binary-file', 'secret']);

/** A delivery precondition failed; the message is safe to persist and show. */
class DeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryRejectedError';
  }
}

export function pullRequestTitle(task: PersistedTask, contract: PlanningIssue, knownSecrets: readonly string[]): string {
  const identifier = contract.source?.linearIdentifier ?? task.linearIdentifier;
  return untrustedText(`${identifier}: ${contract.title}`.replace(/\s+/g, ' '), knownSecrets, 240);
}

/** Pull request description built from trusted identities plus neutralized contract and reviewer text. */
export function pullRequestBody(input: {
  task: PersistedTask;
  contract: PlanningIssue;
  repository: string;
  commit: string;
  baseCommit: string;
  checks: readonly string[];
  reviewSummary: string;
  siblingRepositories: readonly string[];
  knownSecrets: readonly string[];
}): string {
  const text = (value: string, limit: number) => untrustedText(value, input.knownSecrets, limit);
  const identifier = input.contract.source?.linearIdentifier ?? input.task.linearIdentifier;
  const quote = (value: string) => value.split('\n').map((line) => `> ${line}`).join('\n');
  const sections = [
    `Implements Linear issue **${identifier}** in \`${input.repository}\`.`,
    `## Goal\n\n${quote(text(input.contract.body.goal, 2_000))}`,
    `## Acceptance criteria\n\n${input.contract.body.acceptanceCriteria.map((criterion) => `- ${text(criterion, 500)}`).join('\n')}`,
    `## Automated review\n\n${quote(text(input.reviewSummary, 2_000))}`,
    [
      '## Orchestrator verification',
      '',
      `- Base commit \`${shortSha(input.baseCommit)}\`, reviewed head \`${shortSha(input.commit)}\`.`,
      `- Repository quality checks passed on the reviewed head: ${input.checks.map((check) => `\`${check}\``).join(', ') || 'none configured'}.`,
      '- Every commit was written by the orchestrator after its diff policy and ownership checks.',
      input.siblingRepositories.length > 0 ? `- The same issue also changes: ${input.siblingRepositories.map((name) => `\`${name}\``).join(', ')}. The issue is complete only when every pull request is merged.` : null,
      '- Merging requires human review and the repository\'s required checks. The orchestrator never merges.',
    ].filter((line) => line !== null).join('\n'),
    `<!-- kelolakelas-ai-orchestrator task=${input.task.id} repository=${input.repository} -->`,
  ];
  return sections.join('\n\n').slice(0, 60_000);
}

/**
 * `PR_CREATED`: delivers the reviewed branch of every declared repository. Before anything leaves the host the worktree
 * ownership, the registered remote, the reviewed and gated commits, commit authorship, and the cumulative diff are
 * re-verified. The push never forces. Exactly one pull request per work unit is created or recovered, and each is linked
 * to the Linear issue. Every side effect is reconciled with the remote before it is attempted, so a retry after a crash,
 * a lost response, or an operator retry never duplicates a push, pull request, or Linear update.
 */
export class PullRequestStage implements StageHandler {
  constructor(private readonly deps: DeliveryDependencies) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const { deps } = this;
    const { task } = context;
    let scope: Awaited<ReturnType<typeof startAttempt>> | undefined;
    try {
      const loaded = await loadTaskWorkspaces(deps, task);
      const approved = await readCheckpoint(context, checkpointKeys.reviewApproved, reviewApprovedSchema);
      const passed = await readCheckpoint(context, checkpointKeys.qualityPassed, qualityPassedSchema);
      if (approved === undefined || passed === undefined || !sameHeads(approved.heads, loaded.heads) || !sameHeads(passed.heads, loaded.heads)) {
        return manualDeliveryIntervention('Delivery requires an approved review and passing quality gates for the current commits');
      }
      scope = await startAttempt(deps, task, { heads: loaded.heads });

      const pullRequests: Array<{ repository: string; github: string; number: number; url: string; head: string }> = [];
      for (const unit of loaded.units) {
        if (context.signal.aborted) return { kind: 'interrupted' };
        const repository = deps.registry.get(unit.repository);
        await this.verifyGitHubRepository(repository);
        await this.verifyBranchContent(task, unit);
        await this.push(task, unit, context.signal);
        await deps.tasks.recordWorkUnitDelivery(task.id, deps.workerId, unit.repository, { pushedCommit: unit.head, state: 'PR_CREATED', outcome: 'Reviewed branch pushed' });

        const pullRequest = await this.ensurePullRequest(task, loaded, unit, repository, approved.summary);
        await deps.tasks.recordWorkUnitDelivery(task.id, deps.workerId, unit.repository, {
          state: 'PR_CREATED',
          outcome: `Pull request #${pullRequest.number} open`,
          pullRequest: { number: pullRequest.number, url: pullRequest.url },
        });
        await syncLinearPullRequestLink(deps, task, { repository: unit.repository, github: repository.github, number: pullRequest.number, url: pullRequest.url });
        context.log('pull_request_ready', { repository: unit.repository, pullRequest: pullRequest.number, head: pullRequest.headSha });
        pullRequests.push({ repository: unit.repository, github: repository.github, number: pullRequest.number, url: pullRequest.url, head: unit.head });
      }

      await syncLinearComment(deps, task, {
        event: 'pull-requests-opened',
        identity: loaded.heads,
        body: [
          '**Pull requests opened** by the KelolaKelas AI orchestrator.',
          '',
          ...pullRequests.map((entry) => `- \`${entry.repository}\`: [${entry.github}#${entry.number}](${entry.url}) at \`${shortSha(entry.head)}\``),
          '',
          'Required checks and human review are pending.',
        ].join('\n'),
      });
      await completeAttempt(scope, { category: null, evidence: { pullRequests } });
      return { kind: 'advance', to: 'WAITING_CI', reason: `Pull requests open: ${pullRequests.map((entry) => `${entry.repository}#${entry.number}`).join(', ')}`, lastError: null };
    } catch (error) {
      if (error instanceof DeliveryRejectedError) {
        if (scope) await completeAttempt(scope, { category: 'delivery-rejected', evidence: { detail: error.message } });
        await notifyLinearBestEffort(deps, task, { event: 'delivery-blocked', identity: error.message, body: `**Delivery blocked**; manual intervention required.\n\n${untrustedText(error.message, deps.knownSecrets, 1_000)}` }, context.log);
        return manualDeliveryIntervention(error.message);
      }
      const { outcome, category } = classifyDeliveryError(deps, error);
      // A wait keeps the attempt open so the next run continues it instead of recording one attempt per retry.
      if (scope && outcome.kind !== 'wait') await completeAttempt(scope, { category, evidence: { detail: outcome.kind === 'advance' ? outcome.lastError ?? null : null } });
      return outcome;
    }
  }

  private async verifyGitHubRepository(repository: RegisteredRepository): Promise<void> {
    const metadata = await this.deps.github.getRepository(repository.github);
    if (metadata.fullName !== repository.github) throw new DeliveryRejectedError(`GitHub reports ${metadata.fullName} for registered repository ${repository.github}`);
    if (metadata.archived) throw new DeliveryRejectedError(`GitHub repository ${repository.github} is archived`);
    // The push itself uses the host's Git credentials; an explicit denial here means the account is misconfigured.
    if (metadata.canPush === false) throw new DeliveryRejectedError(`GitHub reports no push permission on ${repository.github} for the orchestrator token`);
  }

  /**
   * Proves the branch contains only orchestrator commits for this task on top of the base and re-applies the content
   * rules of the diff policy to the whole change, so nothing inspected commit by commit can combine into a violation.
   */
  private async verifyBranchContent(task: PersistedTask, unit: Unit): Promise<void> {
    const { deps } = this;
    if (unit.head === unit.baseCommit) throw new DeliveryRejectedError(`${unit.repository} has no commits to deliver`);
    const commits = await deps.changes.commitsInRange(unit.workspacePath, unit.baseCommit, unit.head);
    for (const commit of commits) {
      if (commit.authorEmail !== deps.agents.commitAuthor.email || commit.authorName !== deps.agents.commitAuthor.name) {
        throw new DeliveryRejectedError(`Commit ${shortSha(commit.sha)} in ${unit.repository} was not authored by the orchestrator`);
      }
      if (commit.parents.length !== 1) throw new DeliveryRejectedError(`Commit ${shortSha(commit.sha)} in ${unit.repository} is a merge commit`);
      if (commit.taskTrailers.length !== 1 || commit.taskTrailers[0] !== task.id) {
        throw new DeliveryRejectedError(`Commit ${shortSha(commit.sha)} in ${unit.repository} does not carry this task's trailer`);
      }
    }
    const changes = await deps.changes.collectRange(unit.repository, unit.workspacePath, unit.baseCommit, unit.head, deps.agents.diffPolicy.maxChangedLines);
    if (changes.patchSkipped) throw new DeliveryRejectedError(`The change in ${unit.repository} exceeds ${deps.agents.diffPolicy.maxChangedLines} lines and cannot be re-inspected`);
    const violations = evaluateChanges({ changes: [changes], policy: deps.agents.diffPolicy, required: [], plannedPaths: {}, knownSecrets: deps.knownSecrets })
      .violations.filter((violation) => cumulativeRules.has(violation.rule));
    if (violations.length > 0) throw new DeliveryRejectedError(`Branch content in ${unit.repository} violates the diff policy: ${describeViolations(violations)}`);
  }

  private async push(task: PersistedTask, unit: Unit, signal: AbortSignal): Promise<void> {
    const { deps } = this;
    const key = `kelolakelas-orchestrator:${task.id}:git-push:${unit.repository}:${unit.head}`;
    await idempotentOperation(deps, task, { type: 'GIT_PUSH', key, request: { repository: unit.repository, branch: unit.branch, commit: unit.head } }, async () => {
      const state = await deps.workspaces.pushTaskBranch(unit, unit.head, signal);
      return { state: state.kind, remoteHead: state.remoteHead };
    });
    // Observed every time, including after a recorded push: the remote branch may have been rewritten since.
    const state = await deps.workspaces.inspectRemoteBranch(unit, unit.head, signal);
    if (state.kind === 'absent') throw new DeliveryRejectedError(`Remote branch ${unit.branch} of ${unit.repository} was deleted after it was pushed`);
    if (state.kind === 'diverged') throw new DeliveryRejectedError(`Remote branch ${unit.branch} of ${unit.repository} no longer contains the reviewed commit; it was force-pushed or replaced`);
  }

  private async ensurePullRequest(task: PersistedTask, loaded: LoadedWorkspaces, unit: Unit, repository: RegisteredRepository, reviewSummary: string): Promise<GitHubPullRequest> {
    const { deps } = this;
    const recorded = (await deps.tasks.getWorkUnits(task.id)).find((entry) => entry.repository === unit.repository)?.pullRequestNumber ?? null;
    const key = `kelolakelas-orchestrator:${task.id}:github-pull-request:${unit.repository}`;
    const found = await this.reconcilePullRequest(unit, repository, recorded);
    if (found !== null) {
      await idempotentOperation(deps, task, { type: 'GITHUB_PULL_REQUEST', key, request: { repository: repository.github, head: unit.branch, base: repository.baseBranch } }, async () => ({ number: found.number, url: found.url, reconciled: true }));
      return found;
    }

    const operation = await idempotentOperation(deps, task, { type: 'GITHUB_PULL_REQUEST', key, request: { repository: repository.github, head: unit.branch, base: repository.baseBranch } }, async () => {
      const quality = deps.config.repositories[repository.name]?.quality.checks.map((check) => check.name) ?? [];
      const created = await deps.github.createPullRequest(repository.github, {
        title: pullRequestTitle(task, loaded.contract, deps.knownSecrets),
        head: unit.branch,
        base: repository.baseBranch,
        draft: deps.delivery.draftPullRequests,
        body: pullRequestBody({
          task, contract: loaded.contract, repository: unit.repository, commit: unit.head, baseCommit: unit.baseCommit, checks: quality, reviewSummary,
          siblingRepositories: loaded.units.map((entry) => entry.repository).filter((name) => name !== unit.repository), knownSecrets: deps.knownSecrets,
        }),
      });
      return { number: created.number, url: created.url, reconciled: false };
    }).catch((error: unknown) => {
      // A pull request created by an earlier attempt whose response was lost may not be listed yet. GitHub refuses a
      // second open pull request for the same head and base, so this is reconciled on the next run rather than blocked.
      if (error instanceof GitHubRequestError && error.status === 422 && /already exists/i.test(error.message)) {
        throw new GitHubRequestError(error.message, 'transient', error.status);
      }
      throw error;
    });
    if (operation.repeated) {
      throw new DeliveryRejectedError(`Pull request #${String(operation.response.number)} recorded for ${unit.repository} is no longer found for branch ${unit.branch}`);
    }
    const created = await deps.github.getPullRequest(repository.github, Number(operation.response.number));
    this.verifyPullRequest(unit, repository, created, recorded);
    return created;
  }

  /** Finds the work unit's existing pull request. Closed, duplicated, retargeted, or rewritten pull requests need an operator. */
  private async reconcilePullRequest(unit: Unit, repository: RegisteredRepository, recorded: number | null): Promise<GitHubPullRequest | null> {
    const pullRequests = await this.deps.github.findPullRequests(repository.github, unit.branch);
    const open = pullRequests.filter((pullRequest) => pullRequest.state === 'open');
    const merged = pullRequests.filter((pullRequest) => pullRequest.merged);
    if (open.length > 1) throw new DeliveryRejectedError(`Branch ${unit.branch} of ${unit.repository} has ${open.length} open pull requests`);
    const candidate = open[0] ?? (merged.length === 1 ? merged[0] : undefined);
    if (candidate === undefined) {
      if (merged.length > 1) throw new DeliveryRejectedError(`Branch ${unit.branch} of ${unit.repository} has several merged pull requests`);
      if (pullRequests.length > 0) {
        throw new DeliveryRejectedError(`Pull request #${pullRequests[0]?.number} for ${unit.repository} was closed without merging; reopen it or cancel the task`);
      }
      if (recorded !== null) throw new DeliveryRejectedError(`Recorded pull request #${recorded} for ${unit.repository} is no longer found for branch ${unit.branch}`);
      return null;
    }
    this.verifyPullRequest(unit, repository, candidate, recorded);
    // A head that moved past the reviewed commit (for example "Update branch") still contains it; anything else was rewritten.
    if (candidate.headSha !== unit.head) {
      const relation = await this.deps.github.compareCommits(repository.github, unit.head, candidate.headSha);
      if (relation !== 'ahead' && relation !== 'identical') {
        throw new DeliveryRejectedError(`Pull request #${candidate.number} for ${unit.repository} no longer contains the reviewed commit ${shortSha(unit.head)}`);
      }
    }
    return candidate;
  }

  private verifyPullRequest(unit: Unit, repository: RegisteredRepository, pullRequest: GitHubPullRequest, recorded: number | null): void {
    if (recorded !== null && recorded !== pullRequest.number) {
      throw new DeliveryRejectedError(`Pull request #${pullRequest.number} for ${unit.repository} replaced recorded pull request #${recorded}`);
    }
    if (pullRequest.headRepository !== repository.github || pullRequest.headRef !== unit.branch) {
      throw new DeliveryRejectedError(`Pull request #${pullRequest.number} does not come from ${repository.github}:${unit.branch}`);
    }
    if (pullRequest.baseRef !== repository.baseBranch) {
      throw new DeliveryRejectedError(`Pull request #${pullRequest.number} for ${unit.repository} targets ${pullRequest.baseRef}, not ${repository.baseBranch}`);
    }
  }
}
