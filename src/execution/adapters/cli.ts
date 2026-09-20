import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Effort } from '../../types/model.js';
import type { AgentRunRequest, AgentRunner, AgentRunResult, AgentUsage } from '../agent-runner.js';
import { toStrictJsonSchema } from '../agent-results.js';
import { allowlistedEnvironment, runBoundedProcess } from '../bounded-process.js';
import type { CommandSandbox } from '../sandbox.js';
import { redactSecrets } from '../secrets.js';
import { classifyRunnerFailure, parseRetryAfter } from '../failure-classification.js';
import { readJsonPath, readTokenCount } from './cli-contract.js';

const maxMessageLength = 2_000;
const tailBytes = 16 * 1024;

/** Operator-declared command line for one `kind: cli` provider, as validated by configuration. */
export interface CliTransport {
  args: readonly string[];
  prompt: 'stdin' | 'argument';
  result: { source: 'stdout' | 'file'; path: string };
  failure?: { path: string; values: readonly string[]; messagePath?: string | undefined } | undefined;
  usage?: {
    inputTokens: string;
    cachedInputTokens?: string | undefined;
    outputTokens: string;
    reasoningOutputTokens?: string | undefined;
  } | undefined;
}

export interface CliAdapterOptions {
  executable: string;
  transport: CliTransport;
  /** Provider-specific effort names, resolved from the provider's `effort` map over the adapter's own. */
  effort: Record<Effort, string>;
  /**
   * The orchestrator's command sandbox. It wraps the model client's own process, which is the only confinement this
   * adapter can offer: a declaratively configured client brings no command sandbox of its own, so its confinement is
   * derived from this sandbox and never from configuration.
   */
  sandbox: CommandSandbox;
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
 * Runs any command-line model client from configuration alone. The adapter holds no provider vocabulary: the operator
 * supplies the argument template, where the result is read from, and how usage and failure are reported, and the
 * adapter performs those substitutions and reads those paths.
 *
 * Two things configuration cannot change are how the process is confined and what `access` means. The process is wrapped
 * in the orchestrator's command sandbox, and write access is granted by making the task directory writable inside that
 * sandbox rather than by asking the client to police itself. Network access stays open, because the client must reach its
 * own API; a client that also confines the commands the model issues for itself therefore keeps its own adapter kind.
 */
export class CliAdapter implements AgentRunner {
  readonly kind = 'cli';
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CliAdapterOptions) {
    this.environment = allowlistedEnvironment(options.sourceEnvironment, [...options.baseEnvironment, ...options.extraEnvironment], { LANG: 'C.UTF-8', NO_COLOR: '1' });
  }

  /** The command line one run performs, with every placeholder the operator declared substituted. */
  arguments(request: Pick<AgentRunRequest<unknown>, 'model' | 'taskDirectory' | 'prompt' | 'resultSchema'>, files: { schema: string; result: string }): string[] {
    const substitutions: Record<string, string> = {
      '{model}': request.model.model,
      '{effort}': this.options.effort[request.model.effort],
      '{schema}': JSON.stringify(toStrictJsonSchema(request.resultSchema)),
      '{schemaFile}': files.schema,
      '{resultFile}': files.result,
      '{taskDirectory}': request.taskDirectory,
      '{prompt}': request.prompt,
    };
    return this.options.transport.args.map((argument) => argument.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, (placeholder) => substitutions[placeholder] ?? placeholder));
  }

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const now = this.options.clock ?? (() => new Date());
    await mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.options.scratchRoot, `${request.role}-`));
    try {
      const files = { schema: join(directory, 'result-schema.json'), result: join(directory, 'result.json'), stdout: join(directory, 'stdout.json') };
      await writeFile(files.schema, JSON.stringify(toStrictJsonSchema(request.resultSchema)), { mode: 0o600 });

      /**
       * Write access is granted by the sandbox, not by the client. The scratch directory is writable in both modes so
       * the client can write the result file it was told to write. A writing stage also gets the task directory; a
       * reading stage gets it mounted read-only, because every role must be able to read the repository it works on.
       */
      const writing = request.access === 'workspace-write';
      const wrapped = this.options.sandbox.wrap({
        executable: this.options.executable,
        args: this.arguments(request, files),
        cwd: request.taskDirectory,
        writablePaths: writing ? [request.taskDirectory, directory] : [directory],
        readOnlyPaths: writing ? [] : [request.taskDirectory],
        // The model client must reach its own API; without the network it cannot run at all.
        network: true,
      });

      /**
       * The whole output is accumulated rather than only its tail, because the result is read from it. It is bounded, so
       * a client that floods stdout is stopped instead of exhausting memory.
       */
      const collected: string[] = [];
      let collectedBytes = 0;
      let flooded = false;
      const execution = await runBoundedProcess({
        executable: wrapped.executable,
        args: wrapped.args,
        cwd: request.taskDirectory,
        env: { ...this.environment, ...wrapped.environment },
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        stdin: this.options.transport.prompt === 'stdin' ? request.prompt : '',
        tailBytes,
        maxOutputBytes: this.options.maxEventBytes,
        onStdoutLine: (line) => {
          if (flooded) return;
          collectedBytes += Buffer.byteLength(line) + 1;
          if (collectedBytes > this.options.maxResultBytes) {
            flooded = true;
            return;
          }
          collected.push(line);
        },
      });

      const metrics: { usage: AgentUsage | null; durationMs: number } = { usage: null, durationMs: execution.durationMs };
      const detail = (fallback: string) => this.safeMessage(execution.stderrTail.trim() || fallback);

      switch (execution.outcome) {
        case 'aborted': return { ...metrics, kind: 'cancelled', message: 'Runner cancelled' };
        case 'timeout': return { ...metrics, kind: 'timeout', message: `Runner exceeded ${Math.round(request.timeoutMs / 1_000)}s` };
        case 'output-limit': return { ...metrics, kind: 'failed', message: `Runner output exceeded ${this.options.maxEventBytes} bytes` };
        case 'spawn-error': return { ...metrics, kind: 'failed', message: this.safeMessage(`Runner could not start: ${execution.spawnError ?? 'unknown error'}`) };
        case 'exited': break;
      }
      if (execution.exitCode !== 0) {
        const message = detail(`Runner exited with ${execution.exitCode ?? execution.signal ?? 'unknown status'}`);
        const category = classifyRunnerFailure(message);
        if (category === 'failed') return { ...metrics, kind: 'failed', message };
        return { ...metrics, kind: category, message, retryAfter: parseRetryAfter(message, now()) };
      }
      if (flooded) return { ...metrics, kind: 'failed', message: `Runner output exceeded the ${this.options.maxResultBytes} byte result limit` };

      const reading = await this.readOutput(files, execution.stdoutTail, collected.join('\n'));
      if (reading.kind !== 'completed') return { ...metrics, ...reading };

      /**
       * A client that reports failure inside a successful exit is only visible through the declaration. Claude Code does
       * exactly this: it exits 0 on an API error and describes the failure in its output, so without this check a usage
       * limit would be recorded as invalid output and retried instead of pausing the task.
       */
      const failure = this.options.transport.failure;
      if (failure !== undefined) {
        const value = reading.document === undefined ? undefined : readJsonPath(reading.document, failure.path);
        // Compared as text, because the same signal is a boolean in one client and a string in another.
        const reported = value === null || typeof value === 'object' ? undefined : String(value);
        const marked = reported !== undefined && failure.values.some((candidate) => candidate.toLowerCase() === reported.toLowerCase());
        if (marked) {
          const detail = failure.messagePath === undefined ? undefined : readJsonPath(reading.document, failure.messagePath);
          const message = this.safeMessage(typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : `Runner reported ${reported}`);
          const category = classifyRunnerFailure(message);
          if (category === 'failed') return { ...metrics, kind: 'failed', message };
          return { ...metrics, kind: category, message, retryAfter: parseRetryAfter(message, now()) };
        }
      }

      const validated = request.resultSchema.safeParse(reading.output);
      if (!validated.success) {
        const issues = validated.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
        return { ...metrics, kind: 'invalid-output', message: this.safeMessage(`Result does not match schema: ${issues.join('; ')}`) };
      }
      return { ...metrics, usage: this.readUsage(reading.document), kind: 'completed', output: validated.data };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async readOutput(
    files: { schema: string; result: string },
    stdoutTail: string,
    stdout: string,
  ): Promise<{ kind: 'completed'; output: unknown; document: unknown } | { kind: 'invalid-output'; message: string }> {
    if (this.options.transport.result.source === 'file') {
      const size = await stat(files.result).then((entry) => entry.size, () => undefined);
      if (size === undefined) {
        return { kind: 'invalid-output', message: this.safeMessage('Runner produced no result file') };
      }
      if (size > this.options.maxResultBytes) return { kind: 'invalid-output', message: `Result is ${size} bytes; limit is ${this.options.maxResultBytes}` };
      const parsed = parseJson(await readFile(files.result, 'utf8'));
      if (parsed.kind === 'invalid') return { kind: 'invalid-output', message: 'Result file is not valid JSON' };
      const selected = readJsonPath(parsed.value, this.options.transport.result.path);
      if (selected === undefined) return { kind: 'invalid-output', message: this.safeMessage(`Result file has no value at declared path ${this.options.transport.result.path || '(root)'}`) };
      return { kind: 'completed', output: selected, document: parsed.value };
    }
    if (stdout.trim() === '') return { kind: 'invalid-output', message: this.safeMessage(`Runner produced no output${stdoutTail.trim() === '' ? '' : ': output was truncated before it could be read'}`) };
    const parsed = parseJson(stdout);
    if (parsed.kind === 'invalid') {
      // A client that prints progress and then the result cannot be parsed as one document; report what it did print.
      return { kind: 'invalid-output', message: this.safeMessage(`Runner output is not valid JSON: ${stdout.slice(-500)}`) };
    }
    const selected = readJsonPath(parsed.value, this.options.transport.result.path);
    if (selected === undefined) return { kind: 'invalid-output', message: this.safeMessage(`Runner output has no value at declared result path ${this.options.transport.result.path || '(root)'}`) };
    return { kind: 'completed', output: selected, document: parsed.value };
  }

  /** Usage the operator declared, read from the parsed document. An absent path records no usage rather than zero. */
  private readUsage(document: unknown): AgentUsage | null {
    const usage = this.options.transport.usage;
    if (usage === undefined || document === undefined) return null;
    const inputTokens = readTokenCount(readJsonPath(document, usage.inputTokens));
    const outputTokens = readTokenCount(readJsonPath(document, usage.outputTokens));
    if (inputTokens === 0 && outputTokens === 0) return null;
    return {
      inputTokens,
      cachedInputTokens: usage.cachedInputTokens === undefined ? 0 : readTokenCount(readJsonPath(document, usage.cachedInputTokens)),
      outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens === undefined ? 0 : readTokenCount(readJsonPath(document, usage.reasoningOutputTokens)),
    };
  }

  private safeMessage(message: string): string {
    const redacted = redactSecrets(message, this.options.knownSecrets);
    return redacted.length > maxMessageLength ? `${redacted.slice(0, maxMessageLength)}…` : redacted;
  }
}

function parseJson(text: string): { kind: 'valid'; value: unknown } | { kind: 'invalid' } {
  try {
    return { kind: 'valid', value: JSON.parse(text) };
  } catch {
    return { kind: 'invalid' };
  }
}
