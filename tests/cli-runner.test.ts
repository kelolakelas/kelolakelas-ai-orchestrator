import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { analysisResultSchema, analysisResultVersion, type AnalysisResult } from '../src/execution/agent-results.js';
import type { AgentRunRequest } from '../src/execution/agent-runner.js';
import { CliAdapter, type CliTransport } from '../src/execution/adapters/cli.js';
import { resolveEffortMap, adapterCapabilitiesOf } from '../src/execution/adapters/capabilities.js';
import { baseRunnerEnvironment } from '../src/execution/provider-registry.js';
import { BubblewrapSandbox, NoSandbox, sandboxHome } from '../src/execution/sandbox.js';
import { analysisResult } from './support/agent-fixtures.js';
import { createFakeCli, type FakeCli } from './support/fake-cli.js';
import { testConfig } from './support/config.js';

const now = new Date('2026-09-16T10:00:00.000Z');

const bwrap = '/usr/bin/bwrap';

/** Unprivileged user namespaces can be disabled by the kernel or AppArmor; CI sets REQUIRE_SANDBOX so it never skips. */
function bubblewrapWorks(): boolean {
  const probe = spawnSync(bwrap, ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], { timeout: 10_000 });
  return probe.status === 0;
}

const available = bubblewrapWorks();
if (!available && process.env.REQUIRE_SANDBOX === '1') throw new Error('bubblewrap sandbox tests are required but bwrap cannot create namespaces');
const describeWrapped = available ? describe : describe.skip;

/**
 * A transport written the way an operator would declare one: the template names its flags, the result is read from the
 * file the client was told to write, and neither the adapter nor configuration knows which client this is.
 */
function transport(overrides: Partial<CliTransport> = {}): CliTransport {
  return {
    args: ['--model', '{model}', '--effort', '{effort}', '--schema-file', '{schemaFile}', '--result', '{resultFile}'],
    prompt: 'stdin',
    result: { source: 'file', path: '' },
    ...overrides,
  };
}

describe('declarative CLI runner', () => {
  let fake: FakeCli;
  let taskDirectory: string;

  beforeEach(() => {
    fake = createFakeCli();
    taskDirectory = mkdtempSync(join(tmpdir(), 'cli-task-'));
  });

  afterEach(() => {
    fake.cleanup();
    rmSync(taskDirectory, { recursive: true, force: true });
  });

  function runner(overrides: Partial<ConstructorParameters<typeof CliAdapter>[0]> = {}) {
    const declared = overrides.transport ?? transport();
    return new CliAdapter({
      executable: fake.executable,
      transport: declared,
      effort: resolveEffortMap(adapterCapabilitiesOf('cli'), { max: 'xhigh' }),
      sandbox: new NoSandbox(),
      scratchRoot: fake.scratch,
      sourceEnvironment: { PATH: process.env.PATH, HOME: '/home/runner', MODEL_CLIENT_TOKEN: 'model-client-secret-value', DATABASE_URL: 'postgres://u:p@h/d' },
      extraEnvironment: ['MODEL_CLIENT_TOKEN'],
      maxResultBytes: 64 * 1024,
      maxEventBytes: 1024 * 1024,
      knownSecrets: ['model-client-secret-value'],
      baseEnvironment: baseRunnerEnvironment,
      clock: () => now,
      ...overrides,
    });
  }

  function request(overrides: Partial<AgentRunRequest<AnalysisResult>> = {}): AgentRunRequest<AnalysisResult> {
    return {
      role: 'analyzer',
      model: { provider: 'any-provider', tier: 'terra', model: 'model-terra', effort: 'max' },
      prompt: 'PROMPT BODY',
      taskDirectory,
      access: 'read-only',
      resultSchema: analysisResultSchema,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it('substitutes the operator template and completes on a result file', async () => {
    fake.set({ mode: 'file-result', result: analysisResult() });
    const result = await runner().run(request());
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.output.summary).toBe('Add the feature flag');
    // Everything the template declared is substituted; nothing the adapter invents is appended.
    expect(fake.invocation().args).toEqual([
      '--model', 'model-terra', '--effort', 'xhigh',
      '--schema-file', expect.stringContaining('result-schema.json'),
      '--result', expect.stringContaining('result.json'),
    ]);
    expect(fake.invocation().prompt).toBe('PROMPT BODY');
  });

  it('passes the request result schema to the client verbatim, as the strict object schema the results require', async () => {
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner().run(request());
    const schema = fake.invocation().schemaFile as { type?: string; required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> };
    // Verified against Claude Code: a schema without a `$schema` keyword is accepted, while 2020-12 is rejected by name.
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('schemaVersion');
    expect(Object.keys(schema.properties ?? {})).toEqual(schema.required);
  });

  it('reads the result from standard output when the transport declares it, and a nested path within it', async () => {
    fake.set({ mode: 'stdout-result', result: { envelope: { value: analysisResult() } } });
    const result = await runner({ transport: transport({ result: { source: 'stdout', path: 'envelope.value' } }) }).run(request());
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.output.decision).toBe('proceed');
    // The command line is the declared template and nothing else: the adapter appends no flag of its own.
    expect(fake.invocation().args).toEqual(['--model', 'model-terra', '--effort', 'xhigh', '--schema-file', expect.stringContaining('result-schema.json'), '--result', expect.stringContaining('result.json')]);
  });

  it('delivers the prompt as an argument when the transport declares it instead of stdin', async () => {
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner({ transport: transport({ prompt: 'argument', args: ['--model', '{model}', '--schema-file', '{schemaFile}', '--result', '{resultFile}', '{prompt}'] }) }).run(request());
    expect(fake.invocation().args.at(-1)).toBe('PROMPT BODY');
    expect(fake.invocation().prompt).toBe('');
  });

  it('reports token usage declared by the transport, and no usage at all when none is declared', async () => {
    const usage = { inputTokens: 'usage.input', cachedInputTokens: 'usage.cached', outputTokens: 'usage.output' };
    fake.set({ mode: 'stdout-result', result: analysisResult(), usage: { input: 120, cached: 30, output: 45 } });
    const declared = await runner({ transport: transport({ result: { source: 'stdout', path: 'result' }, usage }) }).run(request());
    expect(declared.usage).toEqual({ inputTokens: 120, cachedInputTokens: 30, outputTokens: 45, reasoningOutputTokens: 0 });

    fake.set({ mode: 'file-result', result: analysisResult(), usage: { input: 120, cached: 30, output: 45 } });
    const undeclared = await runner().run(request());
    // Undeclared usage is absent rather than a fabricated zero, which would corrupt cost reporting.
    expect(undeclared.usage).toBeNull();
  });

  /**
   * The verified behaviour that motivates the failure declaration: this client exits 0 and reports the failure inside its
   * own output. Without the declaration the run would look like invalid output and be retried into the limit.
   */
  it('classifies a failure reported inside a successful exit through the declared failure signal', async () => {
    fake.set({
      mode: 'silent-failure',
      result: { is_error: true, terminal_reason: 'api_error', result: "You've hit your usage limit, try again in 2m 30s" },
    });
    const declared = runner({
      transport: transport({
        result: { source: 'stdout', path: '' },
        failure: { path: 'is_error', values: ['true'], messagePath: 'result' },
      }),
    });
    const result = await declared.run(request());
    expect(result.kind).toBe('usage-limit');
    if (result.kind !== 'usage-limit') return;
    expect(result.message).toContain('usage limit');
    expect(result.retryAfter?.toISOString()).toBe(new Date(now.getTime() + 150_000).toISOString());

    // The same output without the declaration is only invalid output, which is why the declaration exists.
    const undeclared = await runner({ transport: transport({ result: { source: 'stdout', path: '' } }) }).run(request());
    expect(undeclared.kind).toBe('invalid-output');
  });

  it('classifies a rate limit reported by exit code and reports the declared usage limit as a plain failure', async () => {
    fake.set({ mode: 'fail', exitCode: 1, stderr: 'Error: 429 too many requests' });
    expect((await runner().run(request())).kind).toBe('rate-limit');

    fake.set({ mode: 'silent-failure', result: { state: 'FAILED', detail: 'the client refused this request' } });
    const failed = await runner({ transport: transport({ result: { source: 'stdout', path: '' }, failure: { path: 'state', values: ['FAILED'], messagePath: 'detail' } }) }).run(request());
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') return;
    expect(failed.message).toBe('the client refused this request');
  });

  it('reports output that is not JSON, and a missing result file, as invalid output', async () => {
    fake.set({ mode: 'text', text: 'I could not complete this task.' });
    const text = await runner({ transport: transport({ result: { source: 'stdout', path: '' } }) }).run(request());
    expect(text.kind).toBe('invalid-output');

    fake.set({ mode: 'no-result' });
    const missing = await runner().run(request());
    expect(missing.kind).toBe('invalid-output');
    if (missing.kind !== 'invalid-output') return;
    expect(missing.message).toContain('no result file');
  });

  it('reports a result that does not match the schema with the failing field', async () => {
    fake.set({ mode: 'file-result', result: { ...analysisResult(), decision: 'maybe' } });
    const result = await runner().run(request());
    expect(result.kind).toBe('invalid-output');
    if (result.kind !== 'invalid-output') return;
    expect(result.message).toContain('decision');
  });

  it('applies the timeout, the abort signal, and the output limit to the client process', async () => {
    fake.set({ mode: 'hang' });
    expect((await runner().run(request({ timeoutMs: 1_000 }))).kind).toBe('timeout');

    fake.set({ mode: 'hang' });
    const controller = new AbortController();
    const cancelled = runner().run(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);
    expect((await cancelled).kind).toBe('cancelled');

    fake.set({ mode: 'flood' });
    expect((await runner({ maxEventBytes: 64 * 1024 }).run(request())).kind).toBe('failed');
  });

  it('redacts known secrets from a failure message', async () => {
    fake.set({ mode: 'fail', exitCode: 1, stderr: 'request failed with model-client-secret-value' });
    const result = await runner().run(request());
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.message).not.toContain('model-client-secret-value');
    expect(result.message).toMatch(/\[redacted\]/i);
  });

  it('passes only the configured environment to the client', async () => {
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner().run(request());
    const environment = fake.invocation().env;
    expect(environment.MODEL_CLIENT_TOKEN).toBe('model-client-secret-value');
    expect(environment.DATABASE_URL).toBeUndefined();
  });

  it('gives a writing stage the task directory and a reading stage only the scratch directory', async () => {
    let wrapped: { writablePaths: readonly string[] } | undefined;
    const spy = {
      kind: 'none' as const,
      wrap: (request: { writablePaths: readonly string[] }) => {
        wrapped = request;
        return { executable: fake.executable, args: [...(request as unknown as { args: string[] }).args], environment: {} };
      },
    };
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner({ sandbox: spy }).run(request({ access: 'workspace-write' }));
    expect(wrapped?.writablePaths[0]).toBe(taskDirectory);
    // The scratch directory is writable too, so the client can write the result file it was told to write.
    expect(wrapped?.writablePaths[1]).toContain(fake.scratch);

    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner({ sandbox: spy }).run(request({ access: 'read-only' }));
    expect(wrapped?.writablePaths).toHaveLength(1);
  });

  it('keeps the network open, because the client cannot reach its own API without it', async () => {
    let network: boolean | undefined;
    const spy = {
      kind: 'none' as const,
      wrap: (wrapped: { network: boolean; args: readonly string[] }) => {
        network = wrapped.network;
        return { executable: fake.executable, args: [...wrapped.args], environment: {} };
      },
    };
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner({ sandbox: spy }).run(request());
    expect(network).toBe(true);
  });

  it('removes its scratch directory after every run, including a failed one', async () => {
    fake.set({ mode: 'file-result', result: analysisResult() });
    await runner().run(request());
    expect(readdirSync(fake.scratch)).toEqual([]);

    fake.set({ mode: 'fail', exitCode: 1, stderr: 'nope' });
    await runner().run(request());
    expect(readdirSync(fake.scratch)).toEqual([]);
  });
});

/**
 * Confinement is derived, never declared: without the orchestrator's sandbox this adapter imposes none, and with it the
 * client's whole process runs inside bubblewrap. These tests run a real client under a real sandbox, so they prove the
 * wiring and the mounting rather than an argument list. The client is `/bin/sh`, because only shell builtins and `/usr`
 * are visible inside the namespace — which is itself part of what the sandbox is supposed to do.
 */
describeWrapped('declarative CLI runner confinement', () => {
  let taskDirectory: string;

  beforeEach(() => {
    taskDirectory = mkdtempSync(join(tmpdir(), 'cli-wrapped-task-'));
    writeFileSync(join(taskDirectory, 'task.txt'), 'task');
  });

  afterEach(() => rmSync(taskDirectory, { recursive: true, force: true }));

  /**
   * Reports its own HOME so the run proves it happened inside the sandbox, and tries to write beside the task it was
   * given. Whether that write survives is decided by `access`, not by the client.
   */
  const script = [
    `echo written > {taskDirectory}/written.txt 2>/dev/null`,
    `printf '{"schemaVersion":"${analysisResultVersion}","decision":"proceed","summary":"home=%s","clarifications":[],"repositories":[{"repository":"web","summary":"patched","changes":[{"path":"feature.txt","action":"modify","rationale":"because"}]}],"acceptanceCriteria":[{"criterion":"c","approach":"a"}],"testPlan":["t"],"risks":[]}' "$HOME"`,
  ].join('; ');

  function run(access: 'read-only' | 'workspace-write') {
    const base = testConfig();
    const config = validateConfig({
      timezone: base.timezone,
      schedule: { days: {} },
      linear: { teamKey: 'KEL' },
      limits: {},
      models: base.models,
      sandbox: { kind: 'bubblewrap', executable: bwrap, readOnlyPaths: ['/usr', '/etc'], writablePaths: [], maskedPaths: [] },
    }).sandbox;
    const runner = new CliAdapter({
      executable: '/bin/sh',
      // The trailing arguments become the shell's positional parameters; only the schema placeholder matters here.
      transport: { args: ['-c', script, '{schema}'], prompt: 'stdin', result: { source: 'stdout', path: '' } },
      effort: resolveEffortMap(adapterCapabilitiesOf('cli'), {}),
      sandbox: new BubblewrapSandbox(config),
      scratchRoot: join(taskDirectory, 'scratch'),
      sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/' },
      extraEnvironment: [],
      maxResultBytes: 256 * 1024,
      maxEventBytes: 4 * 1024 * 1024,
      knownSecrets: [],
      baseEnvironment: baseRunnerEnvironment,
      clock: () => now,
    });
    return runner.run({
      role: 'analyzer',
      model: { provider: 'any-provider', tier: 'terra', model: 'model-terra', effort: 'high' },
      prompt: 'PROMPT BODY',
      taskDirectory,
      access,
      resultSchema: analysisResultSchema,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });
  }

  it('runs the client inside bubblewrap, where it sees the sandbox home rather than the service account', async () => {
    const result = await run('workspace-write');
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    // Only bubblewrap overrides HOME, so reading it back proves the client ran inside the sandbox.
    expect(result.output.summary).toBe(`home=${sandboxHome}`);
  });

  /**
   * The reason a `cli` provider may only serve a writing role when the orchestrator's sandbox is configured: the sandbox,
   * not the client and not its own flags, is what stops the model's writes from leaving the directory it was given.
   */
  it('lets a writing stage write the task directory and denies the same write to a reading stage', async () => {
    expect((await run('workspace-write')).kind).toBe('completed');
    expect(readFileSync(join(taskDirectory, 'written.txt'), 'utf8')).toBe('written\n');
    rmSync(join(taskDirectory, 'written.txt'));

    expect((await run('read-only')).kind).toBe('completed');
    expect(existsSync(join(taskDirectory, 'written.txt'))).toBe(false);
  });
});

describe('CLI transport validation', () => {
  /** A configuration that runs agents, so every requirement of that mode applies to the transport under test. */
  function config(cli: unknown, kind = 'cli') {
    const base = testConfig();
    return {
      timezone: base.timezone,
      schedule: { days: {} },
      linear: { teamKey: 'KEL' },
      limits: {},
      orchestrator: { execution: { prepareWorkspaces: true, runAgents: true } },
      workspace: { root: join(tmpdir(), 'cli-validation') },
      repositories: { web: { path: '/srv/kelolakelas-web', github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }] } } },
      agents: { runner: { kind: 'codex-cli', executable: '/usr/local/bin/codex' }, commitAuthor: { name: 'Bot', email: 'bot@example.test' } },
      models: {
        analyzer: { tier: 'terra', effort: 'high' },
        reviewer: { tier: 'terra', effort: 'high' },
        tiers: { luna: { model: 'quick-model' }, terra: { model: 'balanced-model', provider: 'any' }, sol: { model: 'deep-model' } },
        providers: { any: { kind, executable: '/usr/bin/model-client', ...(cli === undefined ? {} : { cli }) } },
      },
    };
  }

  const valid = {
    args: ['--model', '{model}', '--schema-file', '{schemaFile}', '--result', '{resultFile}'],
    prompt: 'stdin',
    result: { source: 'file', path: '' },
  };

  it('accepts a complete transport declaration', () => {
    expect(validateConfig(config(valid)).models.providers['any']?.cli?.args).toHaveLength(6);
  });

  it('requires the cli block for kind cli and rejects it for every other kind', () => {
    expect(() => validateConfig(config(undefined))).toThrow(/cli/);
    expect(() => validateConfig(config(valid, 'codex-cli'))).toThrow(/only used by the cli transport/);
  });

  it('rejects an unknown placeholder, a misplaced prompt, a missing schema, and a missing result file', () => {
    expect(() => validateConfig(config({ ...valid, args: ['--model', '{modle}', '{schemaFile}'] }))).toThrow(/unknown placeholder \{modle\}/);
    expect(() => validateConfig(config({ ...valid, prompt: 'argument' }))).toThrow(/must contain the \{prompt\} placeholder/);
    expect(() => validateConfig(config({ ...valid, args: ['{prompt}', '{schemaFile}', '{resultFile}'], prompt: 'stdin' }))).toThrow(/no args entry may contain/);
    expect(() => validateConfig(config({ ...valid, args: ['--model', '{model}', '{resultFile}'] }))).toThrow(/result schema/);
    expect(() => validateConfig(config({ ...valid, args: ['--model', '{model}', '{schemaFile}', '{resultFile}'], result: { source: 'file', path: '' } }))).not.toThrow();
    expect(() => validateConfig(config({ ...valid, args: ['--model', '{model}', '{schema}', '{resultFile}'], result: { source: 'file', path: '' } }))).not.toThrow();
  });

  it('accepts stdin prompting without a prompt placeholder and a schema passed inline', () => {
    expect(validateConfig(config({ args: ['--model', '{model}', '--schema', '{schema}', '--result', '{resultFile}'], prompt: 'stdin', result: { source: 'stdout', path: 'structured_output' } })).models.providers['any']?.cli?.result?.path).toBe('structured_output');
  });

  it('refuses kind cli through the legacy runner shorthand, which cannot carry a command line', () => {
    const legacy = { ...config(valid), models: { ...config(valid).models, providers: {} }, agents: { runner: { kind: 'cli', executable: '/usr/bin/model-client' }, commitAuthor: { name: 'A', email: 'a@example.com' } } };
    expect(() => validateConfig(legacy)).toThrow(/cannot be cli/);
  });
});
