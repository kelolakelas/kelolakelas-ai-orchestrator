import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { Effort, ModelSelection } from '../routing/model-router.js';
import { toStrictJsonSchema } from './agent-results.js';
import { allowlistedEnvironment, runBoundedProcess } from './bounded-process.js';
import { redactSecrets } from './secrets.js';

export type AgentRole = 'analyzer' | 'implementer' | 'fixer' | 'reviewer';

/** `read-only` agents inspect worktrees; `workspace-write` agents may write only inside the task directory. */
export type AgentAccess = 'read-only' | 'workspace-write';

export interface AgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentRunRequest<T> {
  role: AgentRole;
  /** Chosen by deterministic routing, never by a model. */
  model: ModelSelection;
  prompt: string;
  /** Working root: the task directory that contains only the declared repository worktrees. */
  taskDirectory: string;
  access: AgentAccess;
  resultSchema: z.ZodType<T>;
  timeoutMs: number;
  signal: AbortSignal;
}

interface RunMetrics {
  usage: AgentUsage | null;
  durationMs: number;
}

export type AgentRunResult<T> = RunMetrics & (
  | { kind: 'completed'; output: T }
  /** The run finished but its final message is missing, oversized, not JSON, or fails the result schema. */
  | { kind: 'invalid-output'; message: string }
  | { kind: 'usage-limit'; message: string; retryAfter: Date | null }
  | { kind: 'rate-limit'; message: string; retryAfter: Date | null }
  | { kind: 'timeout'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string }
);

export type AgentRunKind = AgentRunResult<unknown>['kind'];

/** Port for model runners. Implementations must honour `access`, `timeoutMs`, and `signal`, and validate results. */
export interface AgentRunner {
  run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}

/** Variables every runner process needs; credentials are added only through `agents.runner.environment`. */
const baseRunnerEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'CODEX_HOME'] as const;
const maxMessageLength = 2_000;
const tailBytes = 16 * 1024;

const codexEffort: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

export interface CodexCliRunnerOptions {
  executable: string;
  /** Private directory for per-run schema and result files, outside every agent-writable directory. */
  scratchRoot: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  extraEnvironment: readonly string[];
  maxResultBytes: number;
  maxEventBytes: number;
  knownSecrets: readonly string[];
  clock?: () => Date;
}

/** Parses a provider hint such as "try again in 12 minutes". */
export function parseRetryAfter(message: string, now: Date): Date | null {
  const match = /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?/i.exec(message);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) return null;
  const seconds = Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? new Date(now.getTime() + Math.ceil(seconds) * 1_000) : null;
}

export function classifyRunnerFailure(message: string): 'usage-limit' | 'rate-limit' | 'failed' {
  if (/usage limit|usage_limit|insufficient_quota|quota exceeded|exceeded your current quota|plan limit/i.test(message)) return 'usage-limit';
  if (/rate limit|rate_limit|too many requests|\b429\b/i.test(message)) return 'rate-limit';
  return 'failed';
}

/**
 * Runs `codex exec` non-interactively. Codex enforces the sandbox for every model-issued command: `read-only`, or
 * `workspace-write` confined to the task directory plus a private per-run temporary directory, with network access
 * disabled. The shared `/tmp` is excluded because Codex otherwise makes it writable. User configuration,
 * execution-policy rules, and session persistence are ignored so a run depends only on this request. Shell commands
 * run by the agent inherit only core variables, never runner credentials.
 */
export class CodexCliRunner implements AgentRunner {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexCliRunnerOptions) {
    this.environment = allowlistedEnvironment(options.sourceEnvironment, [...baseRunnerEnvironment, ...options.extraEnvironment], { LANG: 'C.UTF-8', NO_COLOR: '1' });
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
      // Writable roots are the task directory and $TMPDIR, which the runner points at a private per-run directory.
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
        args: CodexCliRunner.arguments(request, files),
        cwd: request.taskDirectory,
        env: { ...this.environment, TMPDIR: temporary },
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        stdin: request.prompt,
        tailBytes,
        maxOutputBytes: this.options.maxEventBytes,
        onStdoutLine: (line) => {
          const event = parseEvent(line);
          if (event === undefined) return;
          if (event.type === 'turn.completed') usage = addUsage(usage, event.usage);
          const message = eventError(event);
          if (message !== undefined && errors.length < 20) errors.push(message);
        },
      });
      const metrics: RunMetrics = { usage, durationMs: execution.durationMs };
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

interface RunnerEvent {
  type?: unknown;
  usage?: unknown;
  message?: unknown;
  error?: unknown;
}

function parseEvent(line: string): RunnerEvent | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value as RunnerEvent : undefined;
  } catch {
    return undefined;
  }
}

function eventError(event: RunnerEvent): string | undefined {
  if (event.type === 'error' && typeof event.message === 'string') return event.message;
  if (event.type === 'turn.failed' && event.error !== null && typeof event.error === 'object') {
    const message = (event.error as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'turn failed';
  }
  return undefined;
}

function addUsage(current: AgentUsage | null, raw: unknown): AgentUsage | null {
  if (raw === null || typeof raw !== 'object') return current;
  const value = raw as Record<string, unknown>;
  const read = (key: string) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : 0);
  const base = current ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  return {
    inputTokens: base.inputTokens + read('input_tokens'),
    cachedInputTokens: base.cachedInputTokens + read('cached_input_tokens'),
    outputTokens: base.outputTokens + read('output_tokens'),
    reasoningOutputTokens: base.reasoningOutputTokens + read('reasoning_output_tokens'),
  };
}
