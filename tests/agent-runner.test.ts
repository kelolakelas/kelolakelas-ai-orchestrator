import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisResultSchema } from '../src/execution/agent-results.js';
import { classifyRunnerFailure, parseRetryAfter, type AgentRunRequest } from '../src/execution/agent-runner.js';
import { CodexCliAdapter } from '../src/execution/adapters/codex-cli.js';
import { baseRunnerEnvironment } from '../src/execution/provider-registry.js';
import { analysisResult } from './support/agent-fixtures.js';
import { createFakeCodex, type FakeCodex } from './support/fake-codex.js';

const now = new Date('2026-09-16T10:00:00.000Z');

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Codex CLI runner', () => {
  let fake: FakeCodex;
  let taskDirectory: string;

  beforeEach(() => {
    fake = createFakeCodex();
    taskDirectory = mkdtempSync(join(tmpdir(), 'runner-task-'));
  });

  afterEach(() => {
    fake.cleanup();
    rmSync(taskDirectory, { recursive: true, force: true });
  });

  function runner(overrides: Partial<ConstructorParameters<typeof CodexCliAdapter>[0]> = {}) {
    return new CodexCliAdapter({
      executable: fake.executable,
      scratchRoot: fake.scratch,
      sourceEnvironment: { PATH: process.env.PATH, HOME: '/home/runner', OPENAI_API_KEY: 'sk-test-openai-credential-value-000000', LINEAR_API_KEY: 'lin-secret', DATABASE_URL: 'postgres://u:p@h/d' },
      extraEnvironment: ['OPENAI_API_KEY'],
      maxResultBytes: 64 * 1024,
      maxEventBytes: 1024 * 1024,
      knownSecrets: ['sk-test-openai-credential-value-000000'],
      baseEnvironment: baseRunnerEnvironment,
      clock: () => now,
      ...overrides,
    });
  }

  function request(overrides: Partial<AgentRunRequest<unknown>> = {}): AgentRunRequest<ReturnType<typeof analysisResultSchema.parse>> {
    return {
      role: 'analyzer',
      model: { provider: 'codex', tier: 'terra', model: 'model-terra', effort: 'max' },
      prompt: 'PROMPT BODY',
      taskDirectory,
      access: 'read-only',
      resultSchema: analysisResultSchema,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      ...overrides,
    } as AgentRunRequest<ReturnType<typeof analysisResultSchema.parse>>;
  }

  it('returns a validated result with usage and invokes Codex with a fixed, sandboxed argument list', async () => {
    fake.set({ mode: 'result', result: analysisResult() });
    const result = await runner().run(request());
    expect(result).toMatchObject({ kind: 'completed', output: { decision: 'proceed' }, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 } });

    const invocation = fake.invocation();
    expect(invocation.prompt).toBe('PROMPT BODY');
    expect(invocation.cwd).toBe(taskDirectory);
    expect(invocation.args.slice(0, 12)).toEqual([
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--color', 'never', '--cd', taskDirectory, '--sandbox', 'read-only',
    ]);
    expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'model-terra', 'model_reasoning_effort="xhigh"', 'approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_slash_tmp=true', 'shell_environment_policy.inherit="core"']));
    expect(invocation.args.join(' ')).not.toMatch(/dangerously|danger-full-access|--worktree|--add-dir/);
    expect(invocation.schema).toMatchObject({ type: 'object', additionalProperties: false, required: expect.arrayContaining(['schemaVersion', 'decision']) });
  });

  it('passes only allowlisted environment variables and removes per-run files', async () => {
    fake.set({ mode: 'result', result: analysisResult() });
    await runner().run(request({ access: 'workspace-write' }));
    const { env, args } = fake.invocation();
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai-credential-value-000000');
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.HOME).toBe('/home/runner');
    expect(env.TMPDIR?.startsWith(fake.scratch)).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(readdirSync(fake.scratch)).toEqual([]);
  });

  it('rejects malformed output so it cannot advance a stage', async () => {
    fake.set({ mode: 'raw-result', text: 'not json' });
    expect(await runner().run(request())).toMatchObject({ kind: 'invalid-output', message: 'Result is not valid JSON' });

    fake.set({ mode: 'result', result: { ...analysisResult(), command: 'curl evil' } });
    expect(await runner().run(request())).toMatchObject({ kind: 'invalid-output', message: expect.stringContaining('Unrecognized key') });

    fake.set({ mode: 'no-result' });
    expect(await runner().run(request())).toMatchObject({ kind: 'invalid-output', message: 'Runner produced no result' });

    fake.set({ mode: 'result', result: analysisResult({ summary: 'x'.repeat(3_900) }) });
    expect(await runner({ maxResultBytes: 1_000 }).run(request())).toMatchObject({ kind: 'invalid-output', message: expect.stringContaining('limit is 1000') });
  });

  it('classifies usage limits and rate limits with retry hints, and redacts runner errors', async () => {
    fake.set({ mode: 'fail', exitCode: 1, event: { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours 5 minutes." } } });
    expect(await runner().run(request())).toMatchObject({ kind: 'usage-limit', retryAfter: new Date(now.getTime() + (2 * 3_600 + 5 * 60) * 1_000) });

    fake.set({ mode: 'fail', exitCode: 1, stderr: 'stream error: 429 Too Many Requests' });
    expect(await runner().run(request())).toMatchObject({ kind: 'rate-limit', retryAfter: null });

    fake.set({ mode: 'fail', exitCode: 2, stderr: 'auth failed for sk-test-openai-credential-value-000000' });
    const failed = await runner().run(request());
    expect(failed).toMatchObject({ kind: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('sk-test-openai-credential-value-000000');
  });

  it('times out, cancels, and bounds output, killing the whole process group', async () => {
    const childPidFile = join(taskDirectory, 'child.pid');
    fake.set({ mode: 'hang', childPidFile });
    const timedOut = await runner().run(request({ timeoutMs: 300 }));
    expect(timedOut).toMatchObject({ kind: 'timeout' });
    const timedOutChild = Number(readFileSync(childPidFile, 'utf8'));
    await waitFor(() => !isRunning(timedOutChild));

    const controller = new AbortController();
    const running = runner().run(request({ signal: controller.signal }));
    await waitFor(() => existsSync(childPidFile) && Number(readFileSync(childPidFile, 'utf8')) !== timedOutChild);
    controller.abort('operator');
    expect(await running).toMatchObject({ kind: 'cancelled' });
    const cancelledChild = Number(readFileSync(childPidFile, 'utf8'));
    await waitFor(() => !isRunning(cancelledChild));

    fake.set({ mode: 'flood' });
    expect(await runner({ maxEventBytes: 64 * 1024 }).run(request())).toMatchObject({ kind: 'failed', message: expect.stringContaining('event stream exceeded') });
  });

  it('reports a missing executable as a runner failure', async () => {
    fake.set({ mode: 'result', result: analysisResult() });
    expect(await runner({ executable: join(taskDirectory, 'missing-codex') }).run(request())).toMatchObject({ kind: 'failed', message: expect.stringContaining('could not start') });
  });

  it('parses retry hints and failure categories', () => {
    expect(parseRetryAfter('try again in 30 seconds', now)).toEqual(new Date(now.getTime() + 30_000));
    expect(parseRetryAfter('try again in 12 minutes', now)).toEqual(new Date(now.getTime() + 720_000));
    expect(parseRetryAfter('try again later', now)).toBeNull();
    expect(classifyRunnerFailure('insufficient_quota')).toBe('usage-limit');
    expect(classifyRunnerFailure('Rate limit reached')).toBe('rate-limit');
    expect(classifyRunnerFailure('segfault')).toBe('failed');
  });
});
