import { WorkspaceBlockedError } from '../../workspaces/repository-registry.js';
import { describeViolations, evaluateChanges, type DiffEvidence, type DiffViolation, type RepositoryChanges } from '../diff-policy.js';
import { restoreAll, type ExecutionDependencies, type Heads, type LoadedWorkspaces } from './stage-support.js';

export type ChangeApplication =
  | { kind: 'committed'; commits: Heads; evidence: DiffEvidence[] }
  /** Changes violate the diff policy and were discarded. */
  | { kind: 'rejected'; detail: string; violations: DiffViolation[]; evidence: DiffEvidence[] }
  /** A worktree no longer proves orchestrator ownership, or an agent moved HEAD. Nothing was committed. */
  | { kind: 'integrity'; detail: string };

/** Verifies that an agent left Git state alone: same Git directory, branch, ownership, and HEAD in every worktree. */
export async function verifyAgentLeftGitState(deps: ExecutionDependencies, loaded: LoadedWorkspaces): Promise<string | null> {
  for (const unit of loaded.units) {
    try {
      const { head } = await deps.workspaces.verifyTaskWorkspace(unit);
      if (head !== unit.head) return `HEAD of ${unit.repository} moved from ${unit.head} to ${head} during the agent run`;
    } catch (error) {
      if (error instanceof WorkspaceBlockedError) return error.message;
      throw error;
    }
  }
  return null;
}

/**
 * Inspects agent changes against the diff policy and commits each changed repository, or discards all changes when any
 * repository violates the policy. Commits are local; nothing is pushed.
 */
export async function inspectAndCommit(
  deps: ExecutionDependencies,
  loaded: LoadedWorkspaces,
  options: { required: readonly string[]; plannedPaths: Readonly<Record<string, readonly string[]>>; message: (repository: string) => string },
): Promise<ChangeApplication> {
  const integrity = await verifyAgentLeftGitState(deps, loaded);
  if (integrity !== null) return { kind: 'integrity', detail: integrity };

  const changes: RepositoryChanges[] = [];
  for (const unit of loaded.units) {
    changes.push(await deps.changes.collect(unit.repository, unit.workspacePath, deps.agents.diffPolicy.maxChangedLines));
  }
  const evaluation = evaluateChanges({
    changes,
    policy: deps.agents.diffPolicy,
    required: options.required,
    plannedPaths: options.plannedPaths,
    knownSecrets: deps.knownSecrets,
  });
  if (evaluation.violations.length > 0) {
    await restoreAll(deps, loaded);
    return { kind: 'rejected', detail: describeViolations(evaluation.violations), violations: evaluation.violations, evidence: evaluation.evidence };
  }

  const commits: Heads = { ...loaded.heads };
  for (const unit of loaded.units) {
    if (changes.find((entry) => entry.repository === unit.repository)?.files.length === 0) continue;
    commits[unit.repository] = (await deps.workspaces.commitWorkspace(unit, options.message(unit.repository), deps.agents.commitAuthor)).commit;
  }
  return { kind: 'committed', commits, evidence: evaluation.evidence };
}
