import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { Effort } from '../../types/model.js';
import type { AgentRunRequest, AgentRunner, AgentRunResult, AgentUsage } from '../agent-runner.js';
import { toStrictJsonSchema } from '../agent-results.js';
import { allowlistedEnvironment, runBoundedProcess } from '../bounded-process.js';
import { redactSecrets } from '../secrets.js';
import { addCodexUsage, codexEventError, parseCodexEvent } from './codex-events.js';
import { classifyRunnerFailure, parseRetryAfter } from '../failure-classification.js';

const maxMessageLength = 2_000;
const tailBytes = 16 * 1024;

/**
 * Codex's names for the canonical effort scale. `max` becomes Codex's `xhigh`; the other three coincide. Kept here,
 * next to the argv it feeds, so no other module needs to know Codex's vocabulary.
 */
const codexEffort: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

/** Variables Codex needs beyond the shared base. Credentials still arrive only through configured provider environment. */
export const codexEnvironment = ['CODEX_HOME'] as const;

export interface CodexCliAdapterOptions {
  executable: string;
  /** Private directory for per-run schema and result files, outside every agent-writable directory. */
  scratchRoot: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  extraEnvironment: readonly string[];
  maxResultBytes: number;
  maxEventBytes: number;
  knownSecrets: readonly string[];
  baseEnvironment: readonly string[];
  clock?: () => Date;
}

/**
 * Runs `codex exec` non-interactively. Codex enforces the sandbox for every model-issued command: `read-only`, or
 * `workspace-write` confined to the task directory plus a private per-run temporary directory, with network access
 * disabled. The shared `/tmp` is excluded because Codex otherwise makes it writable. User configuration,
 * execution-policy rules, and session persistence are ignored so a run depends only on this request. Shell commands
 * run by the agent inherit only core variables, never runner credentials.
 */
export class CodexCliAdapter implements AgentRunner {
  readonly kind = 'codex-cli';
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexCliAdapterOptions) {
    this.environment = allowlistedEnvironment(options.sourceEnvironment, [...options.baseEnvironment, ...codexEnvironment, ...options.extraEnvironment], { LANG: 'C.UTF-8', NO_COLOR: '1' });
  }

  static arguments(request: Pick<AgentRunRequest<unknown>, 'model' | 'taskDirectory' | 'access'>, files: { schema: string; result: string }): string[] {
    return [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--color', 'never',
      '--cd', request.taskDirectory,
      '--sandbox', request.access,
      '--model', request.model.model,
      '-c', 'approval_policy="never"',
      '-c', `model_reasoning_effort="${codexEffort[request.model.effort]}"`,
      '-c', 'sandbox_workspace_write.network_access=false',
      // Writable roots are the task directory and $TMPDIR, which the adapter points at a private per-run directory.
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=false',
      '-c', 'shell_environment_policy.inherit="core"',
      '--output-schema', files.schema,
      '--output-last-message', files.result,
      '-',
    ];
  }

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const now = this.options.clock ?? (() => new Date());
    await mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.options.scratchRoot, `${request.role}-`));
    try {
      const files = { schema: join(directory, 'result-schema.json'), result: join(directory, 'result.json') };
      await writeFile(files.schema, JSON.stringify(toStrictJsonSchema(request.resultSchema)), { mode: 0o600 });
      // Agents may write temporary files only here: a sibling of the schema and result files, removed after the run.
      const temporary = join(directory, 'tmp');
      await mkdir(temporary, { mode: 0o700 });

      let usage: AgentUsage | null = null;
      const errors: string[] = [];
      const execution = await runBoundedProcess({
        executable: this.options.executable,
        args: CodexCliAdapter.arguments(request, files),
        cwd: request.taskDirectory,
        env: { ...this.environment, TMPDIR: temporary },
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        stdin: request.prompt,
        tailBytes,
        maxOutputBytes: this.options.maxEventBytes,
        onStdoutLine: (line) => {
          const event = parseCodexEvent(line);
          if (event === undefined) return;
          if (event.type === 'turn.completed') usage = addCodexUsage(usage, event.usage);
          const message = codexEventError(event);
          if (message !== undefined && errors.length < 20) errors.push(message);
        },
      });
      const metrics: { usage: AgentUsage | null; durationMs: number } = { usage, durationMs: execution.durationMs };
      const detail = (fallback: string) => this.safeMessage([...errors, execution.stderrTail.trim()].filter(Boolean).join(' | ') || fallback);

      switch (execution.outcome) {
        case 'aborted': return { ...metrics, kind: 'cancelled', message: 'Runner cancelled' };
        case 'timeout': return { ...metrics, kind: 'timeout', message: `Runner exceeded ${Math.round(request.timeoutMs / 1_000)}s` };
        case 'output-limit': return { ...metrics, kind: 'failed', message: `Runner event stream exceeded ${this.options.maxEventBytes} bytes` };
        case 'spawn-error': return { ...metrics, kind: 'failed', message: this.safeMessage(`Runner could not start: ${execution.spawnError ?? 'unknown error'}`) };
        case 'exited': break;
      }

      if (execution.exitCode !== 0) {
        const message = detail(`Runner exited with ${execution.exitCode ?? execution.signal ?? 'unknown status'}`);
        const category = classifyRunnerFailure(message);
        if (category === 'failed') return { ...metrics, kind: 'failed', message };
        return { ...metrics, kind: category, message, retryAfter: parseRetryAfter(message, now()) };
      }
      return { ...metrics, ...await this.readResult(files.result, request.resultSchema, errors) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async readResult<T>(path: string, schema: z.ZodType<T>, errors: readonly string[]): Promise<{ kind: 'completed'; output: T } | { kind: 'invalid-output'; message: string }> {
    const size = await stat(path).then((entry) => entry.size, () => undefined);
    if (size === undefined) {
      return { kind: 'invalid-output', message: this.safeMessage(errors.length > 0 ? `Runner produced no result: ${errors.join(' | ')}` : 'Runner produced no result') };
    }
    if (size > this.options.maxResultBytes) return { kind: 'invalid-output', message: `Result is ${size} bytes; limit is ${this.options.maxResultBytes}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return { kind: 'invalid-output', message: 'Result is not valid JSON' };
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      return { kind: 'invalid-output', message: this.safeMessage(`Result does not match schema: ${issues.join('; ')}`) };
    }
    return { kind: 'completed', output: validated.data };
  }

  private safeMessage(message: string): string {
    const redacted = redactSecrets(message, this.options.knownSecrets);
    return redacted.length > maxMessageLength ? `${redacted.slice(0, maxMessageLength)}…` : redacted;
  }
}
