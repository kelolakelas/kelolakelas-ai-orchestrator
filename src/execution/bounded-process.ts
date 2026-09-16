import { spawn } from 'node:child_process';

export interface BoundedProcessOptions {
  /** Fixed executable from trusted configuration. It is never interpreted by a shell. */
  executable: string;
  args: readonly string[];
  cwd: string;
  /** The complete child environment; nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
  /** Bytes of the end of each stream kept for evidence. */
  tailBytes: number;
  /** The process group is stopped when stdout plus stderr exceeds this many bytes. */
  maxOutputBytes: number;
  /** Receives complete stdout lines, for example JSONL events. */
  onStdoutLine?: (line: string) => void;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export type BoundedProcessOutcome = 'exited' | 'timeout' | 'aborted' | 'output-limit' | 'spawn-error';

export interface BoundedProcessResult {
  outcome: BoundedProcessOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  stdoutTail: string;
  stderrTail: string;
  outputBytes: number;
  durationMs: number;
}

const maxLineBytes = 8 * 1024 * 1024;

function appendTail(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // A negative PID addresses the whole process group, including descendants such as test watchers.
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
  }
}

/**
 * Runs one trusted command in its own process group with a timeout, cancellation, bounded output, and an explicit
 * environment. Every descendant still running when the command exits, times out, or is aborted is killed.
 */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    return Promise.resolve({ outcome: 'aborted', exitCode: null, signal: null, spawnError: null, stdoutTail: '', stderrTail: '', outputBytes: 0, durationMs: 0 });
  }

  return new Promise((resolve) => {
    let outcome: BoundedProcessOutcome = 'exited';
    let spawnError: string | null = null;
    let stdoutTail = '';
    let stderrTail = '';
    let outputBytes = 0;
    let lineBuffer = '';
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stop = (reason: BoundedProcessOutcome) => {
      if (outcome !== 'exited') return;
      outcome = reason;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), options.killGraceMs ?? 5_000);
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const countOutput = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) stop('output-limit');
    };

    child.stdout.on('data', (chunk: Buffer) => {
      countOutput(chunk);
      const text = chunk.toString('utf8');
      stdoutTail = appendTail(stdoutTail, text, options.tailBytes);
      if (!options.onStdoutLine) return;
      lineBuffer += text;
      let newline = lineBuffer.indexOf('\n');
      while (newline !== -1) {
        options.onStdoutLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf('\n');
      }
      // A single unterminated line this large is not a valid event; drop it rather than buffering without bound.
      if (lineBuffer.length > maxLineBytes) lineBuffer = '';
    });
    child.stderr.on('data', (chunk: Buffer) => {
      countOutput(chunk);
      stderrTail = appendTail(stderrTail, chunk.toString('utf8'), options.tailBytes);
    });
    // The child may exit before reading its input.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');

    child.on('error', (error) => {
      if (outcome === 'exited') outcome = 'spawn-error';
      spawnError = error.message;
    });
    child.on('exit', () => {
      // Leftover descendants would keep the pipes open and outlive the command.
      signalGroup(child.pid, 'SIGKILL');
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.onStdoutLine && lineBuffer !== '') options.onStdoutLine(lineBuffer);
      resolve({
        outcome: spawnError !== null ? 'spawn-error' : outcome,
        exitCode,
        signal,
        spawnError,
        stdoutTail,
        stderrTail,
        outputBytes,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Builds a child environment from an allowlist of variable names. */
export function allowlistedEnvironment(source: NodeJS.ProcessEnv, names: readonly string[], fixed: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...fixed };
}
