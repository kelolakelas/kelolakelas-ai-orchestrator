import type { QualityCommand, RepositoryQualityConfig } from '../config/schema.js';
import { allowlistedEnvironment, runBoundedProcess, type BoundedProcessOutcome } from './bounded-process.js';
import { redactSecrets } from './secrets.js';

export type QualityPhase = 'setup' | 'check';

export interface QualityCommandResult {
  phase: QualityPhase;
  name: string;
  command: readonly string[];
  passed: boolean;
  outcome: BoundedProcessOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Redacted end of stdout and stderr. */
  outputTail: string;
}

export interface RepositoryQualityReport {
  repository: string;
  passed: boolean;
  /** Set when the gate could not run, such as a missing executable. Not a failure the agent can fix. */
  infrastructureError: string | null;
  aborted: boolean;
  results: QualityCommandResult[];
}

/** Variables every repository command receives. Credentials are never inherited. */
const baseCommandEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'] as const;
const tailBytes = 8 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;

export interface QualityGateRunnerOptions {
  quality: (repository: string) => RepositoryQualityConfig;
  sourceEnvironment: NodeJS.ProcessEnv;
  knownSecrets: readonly string[];
}

/**
 * Executes the trusted setup and check commands of one repository inside its worktree. Commands are looked up by
 * repository in operator configuration; callers cannot pass a command. Checks run in order and every check runs, so a
 * fixer receives the complete set of failures. A failed setup command skips the checks.
 */
export class QualityGateRunner {
  constructor(private readonly options: QualityGateRunnerOptions) {}

  hasSetup(repository: string): boolean {
    return this.options.quality(repository).setup.length > 0;
  }

  async run(repository: string, workspacePath: string, phases: 'setup' | 'all', signal: AbortSignal): Promise<RepositoryQualityReport> {
    const quality = this.options.quality(repository);
    const environment = allowlistedEnvironment(this.options.sourceEnvironment, [...baseCommandEnvironment, ...quality.environment], { CI: 'true', NO_COLOR: '1' });
    const report: RepositoryQualityReport = { repository, passed: true, infrastructureError: null, aborted: false, results: [] };
    const planned: Array<[QualityPhase, QualityCommand]> = [
      ...quality.setup.map((command) => ['setup', command] as [QualityPhase, QualityCommand]),
      ...(phases === 'all' ? quality.checks.map((command) => ['check', command] as [QualityPhase, QualityCommand]) : []),
    ];

    for (const [phase, definition] of planned) {
      if (phase === 'check' && report.results.some((result) => result.phase === 'setup' && !result.passed)) break;
      const [executable, ...args] = definition.command as [string, ...string[]];
      const execution = await runBoundedProcess({
        executable,
        args,
        cwd: workspacePath,
        env: environment,
        timeoutMs: definition.timeoutSeconds * 1_000,
        signal,
        tailBytes,
        maxOutputBytes,
      });
      if (execution.outcome === 'aborted') {
        report.aborted = true;
        report.passed = false;
        return report;
      }
      const passed = execution.outcome === 'exited' && execution.exitCode === 0;
      const output = [execution.stdoutTail.trim(), execution.stderrTail.trim()].filter(Boolean).join('\n');
      report.results.push({
        phase,
        name: definition.name,
        command: definition.command,
        passed,
        outcome: execution.outcome,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        outputTail: redactSecrets(output.length > tailBytes ? output.slice(output.length - tailBytes) : output, this.options.knownSecrets),
      });
      if (!passed) report.passed = false;
      if (execution.outcome === 'spawn-error') {
        report.infrastructureError = `${phase} command ${definition.name} could not start: ${execution.spawnError ?? 'unknown error'}`;
        return report;
      }
    }
    return report;
  }
}
