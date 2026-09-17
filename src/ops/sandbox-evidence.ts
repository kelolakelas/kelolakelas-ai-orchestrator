import { loadConfig } from '../config/config.js';
import { GitHubRestProvider } from '../providers/github.js';

/**
 * Collects evidence for the Phase 7 sandbox delivery run against real GitHub and Linear sandbox repositories. It watches
 * one task through a running orchestrator's operator API until it reaches a target state, then verifies with GitHub that
 * each work unit has exactly one pull request. It performs no writes.
 *
 * Usage: ORCHESTRATOR_CONFIG=ops/sandbox/orchestrator.sandbox.yaml ORCHESTRATOR_OPERATOR_TOKEN=... GITHUB_TOKEN=... \
 *   node dist/src/ops/sandbox-evidence.js <LINEAR-IDENTIFIER> [targetState=READY_FOR_HUMAN_REVIEW] [timeoutMinutes=240]
 */

interface TaskDetail {
  task: { id: string; linearIdentifier: string; state: string; lastError: string | null; requiresManualIntervention: boolean };
  workUnits: Array<{ repository: string; branch: string | null; pullRequestNumber: number | null; pullRequestUrl: string | null; mergeCommit: string | null }>;
  attempts: Array<{ stage: string; attempt: number; failureCategory: string | null }>;
}

export interface SandboxRunVerdict {
  passed: boolean;
  problems: string[];
}

/** Pure evaluation of a finished run, so the acceptance rules are unit tested. */
export function evaluateSandboxRun(detail: TaskDetail, targetState: string, pullRequestsPerUnit: Record<string, number>): SandboxRunVerdict {
  const problems: string[] = [];
  if (detail.task.state !== targetState && !(targetState === 'READY_FOR_HUMAN_REVIEW' && detail.task.state === 'COMPLETED')) {
    problems.push(`Task ended in ${detail.task.state}${detail.task.lastError ? `: ${detail.task.lastError}` : ''}`);
  }
  for (const unit of detail.workUnits) {
    const count = pullRequestsPerUnit[unit.repository] ?? 0;
    if (count !== 1) problems.push(`${unit.repository} has ${count} pull requests for ${unit.branch ?? 'no branch'}; expected exactly 1`);
    if (unit.pullRequestNumber === null) problems.push(`${unit.repository} recorded no pull request`);
  }
  return { passed: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const [identifier, targetState = 'READY_FOR_HUMAN_REVIEW', timeoutMinutes = '240'] = process.argv.slice(2);
  const token = process.env.ORCHESTRATOR_OPERATOR_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  if (identifier === undefined || token === undefined || githubToken === undefined) {
    console.error('Usage: ORCHESTRATOR_OPERATOR_TOKEN=... GITHUB_TOKEN=... sandbox-evidence <LINEAR-IDENTIFIER> [targetState] [timeoutMinutes]');
    process.exit(2);
  }
  const config = await loadConfig(process.env.ORCHESTRATOR_CONFIG ?? 'ops/sandbox/orchestrator.sandbox.yaml');
  const base = process.env.ORCHESTRATOR_URL ?? `http://${config.orchestrator.http.host}:${config.orchestrator.http.port}`;
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return await response.json() as T;
  };

  const deadline = Date.now() + Number(timeoutMinutes) * 60_000;
  const timeline: Array<{ at: string; state: string }> = [];
  let detail: TaskDetail | undefined;
  const terminal = new Set([targetState, 'COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED']);
  while (Date.now() < deadline) {
    const { tasks } = await get<{ tasks: Array<{ id: string; linearIdentifier: string }> }>('/operator/tasks');
    const summary = tasks.find((task) => task.linearIdentifier === identifier);
    if (summary !== undefined) {
      detail = await get<TaskDetail>(`/operator/tasks/${summary.id}`);
      if (timeline.at(-1)?.state !== detail.task.state) {
        timeline.push({ at: new Date().toISOString(), state: detail.task.state });
        console.error(`${new Date().toISOString()} ${identifier} ${detail.task.state}`);
      }
      if (terminal.has(detail.task.state)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  if (detail === undefined) throw new Error(`Task ${identifier} never appeared; check intake labels and the dry-run report`);

  const github = new GitHubRestProvider(config.delivery?.github ?? { apiUrl: 'https://api.github.com', requestTimeoutMs: 15_000, maxRetries: 2 }, githubToken);
  const pullRequests: Record<string, number> = {};
  for (const unit of detail.workUnits) {
    const repository = config.repositories[unit.repository as keyof typeof config.repositories];
    if (repository === undefined || unit.branch === null) continue;
    pullRequests[unit.repository] = (await github.findPullRequests(repository.github, unit.branch)).length;
  }
  const verdict = evaluateSandboxRun(detail, targetState, pullRequests);
  console.log(JSON.stringify({
    identifier,
    targetState,
    verdict,
    timeline,
    workUnits: detail.workUnits,
    pullRequests,
    attempts: detail.attempts.map(({ stage, attempt, failureCategory }) => ({ stage, attempt, failureCategory })),
  }, null, 2));
  process.exitCode = verdict.passed ? 0 : 1;
}

if (process.argv[1]?.endsWith('sandbox-evidence.js') || process.argv[1]?.endsWith('sandbox-evidence.ts')) await main();
