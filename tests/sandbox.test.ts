import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig, type RepositoryQualityConfig, type SandboxConfig } from '../src/config/schema.js';
import { runBoundedProcess } from '../src/execution/bounded-process.js';
import { QualityGateRunner } from '../src/execution/quality-gates.js';
import { BubblewrapSandbox, sandboxHome } from '../src/execution/sandbox.js';
import { testConfig } from './support/config.js';

const bwrap = '/usr/bin/bwrap';

function sandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  const base = validateConfig({ ...rawConfig(), sandbox: { kind: 'bubblewrap', executable: bwrap, ...overrides } }).sandbox;
  return base;
}

function rawConfig(): Record<string, unknown> {
  const config = testConfig();
  return { timezone: config.timezone, schedule: { days: {} }, linear: { teamKey: 'KEL' }, models: config.models, limits: {} };
}

/** Unprivileged user namespaces can be disabled by the kernel or AppArmor; CI sets REQUIRE_SANDBOX so it never skips. */
function bubblewrapWorks(): boolean {
  const probe = spawnSync(bwrap, ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], { timeout: 10_000 });
  return probe.status === 0;
}

const available = bubblewrapWorks();
if (!available && process.env.REQUIRE_SANDBOX === '1') throw new Error('bubblewrap sandbox tests are required but bwrap cannot create namespaces');
const describeSandbox = available ? describe : describe.skip;

describe('bubblewrap arguments', () => {
  it('mounts only configured paths, masks existing masked paths last, and never uses a shell', () => {
    const sandbox = new BubblewrapSandbox(
      { kind: 'bubblewrap', executable: bwrap, readOnlyPaths: ['/usr'], writablePaths: ['/var/cache/shared'], maskedPaths: ['/etc/ai-orchestrator', '/missing'] },
      (path) => path !== '/missing' && path !== '/lib32' && path !== '/libx32',
    );
    const wrapped = sandbox.wrap({ executable: 'npm', args: ['test', '$(rm -rf /)'], cwd: '/work/web', writablePaths: ['/work/web'], readOnlyPaths: ['/clones/web/.git'], network: false });

    expect(wrapped.executable).toBe(bwrap);
    expect(wrapped.args).toContain('--unshare-net');
    expect(wrapped.args).toContain('--die-with-parent');
    expect(wrapped.args.slice(-3)).toEqual(['npm', 'test', '$(rm -rf /)']);
    const joined = wrapped.args.join(' ');
    expect(joined).toContain('--ro-bind-try /clones/web/.git /clones/web/.git');
    expect(joined).toContain('--bind /work/web /work/web');
    expect(joined).toContain('--tmpfs /etc/ai-orchestrator');
    expect(joined).not.toContain('/missing');
    expect(wrapped.args.indexOf('--tmpfs', wrapped.args.indexOf('/work/web'))).toBeGreaterThan(wrapped.args.indexOf('/work/web'));
    expect(wrapped.environment).toEqual({ HOME: sandboxHome, TMPDIR: '/tmp' });
  });

  it('keeps network access only when requested', () => {
    const sandbox = new BubblewrapSandbox({ kind: 'bubblewrap', executable: bwrap, readOnlyPaths: [], writablePaths: [], maskedPaths: [] });
    expect(sandbox.wrap({ executable: '/bin/true', args: [], cwd: '/tmp', writablePaths: [], readOnlyPaths: [], network: true }).args).not.toContain('--unshare-net');
  });

  it('rejects configuration that would expose home directories or the root', () => {
    for (const path of ['/', '/home', `/home/someone`, '/root', '/proc', '/run/credentials/ai-orchestrator.service']) {
      expect(() => validateConfig({ ...rawConfig(), sandbox: { kind: 'bubblewrap', readOnlyPaths: [path] } }), path).toThrow(/must not expose/);
    }
    expect(() => validateConfig({ ...rawConfig(), sandbox: { kind: 'bubblewrap', readOnlyPaths: ['/home/someone/.nvm'] } })).not.toThrow();
  });
});

describeSandbox('bubblewrap confinement', () => {
  let root: string;
  let worktree: string;
  let masked: string;

  beforeEach(() => {
    // Outside the home directory, which the sandbox never mounts.
    root = mkdtempSync(join(tmpdir(), 'sandbox-'));
    worktree = join(root, 'worktree');
    masked = join(root, 'orchestrator-config');
    mkdirSync(worktree);
    mkdirSync(masked);
    writeFileSync(join(masked, 'orchestrator.env'), 'GITHUB_TOKEN=ghp_masked\n');
    writeFileSync(join(root, 'outside.txt'), 'outside');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(script: string, options: { network?: boolean; timeoutMs?: number; extraReadOnly?: string[] } = {}) {
    // `root` is under the host /tmp, which the sandbox replaces; mount the test directory explicitly.
    const sandbox = new BubblewrapSandbox(sandboxConfig({ readOnlyPaths: ['/usr', '/etc', ...(options.extraReadOnly ?? [])], maskedPaths: [masked] }));
    const wrapped = sandbox.wrap({ executable: '/bin/sh', args: ['-c', script], cwd: worktree, writablePaths: [worktree], readOnlyPaths: [masked], network: options.network ?? false });
    return runBoundedProcess({
      executable: wrapped.executable,
      args: wrapped.args,
      cwd: worktree,
      env: { PATH: '/usr/bin:/bin', ...wrapped.environment },
      timeoutMs: options.timeoutMs ?? 20_000,
      tailBytes: 16_000,
      maxOutputBytes: 1_000_000,
      killGraceMs: 500,
    });
  }

  it('writes only inside the worktree and sees no host files outside mounted paths', async () => {
    const result = await run([
      'echo changed > result.txt',
      'touch /usr/probe 2>/dev/null && echo usr-writable',
      `test -e ${root}/outside.txt && echo outside-visible`,
      `test -e ${homedir()} && echo home-visible`,
      'echo "home=$HOME tmp=$TMPDIR"',
    ].join('; '));

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(worktree, 'result.txt'), 'utf8')).toBe('changed\n');
    expect(result.stdoutTail).not.toMatch(/usr-writable|outside-visible|home-visible/);
    expect(result.stdoutTail).toContain(`home=${sandboxHome} tmp=/tmp`);
  });

  it('hides the orchestrator process, its environment, and masked credential files', async () => {
    process.env.SANDBOX_TEST_CREDENTIAL = 'orchestrator-only-credential';
    try {
      const result = await run([
        `cat /proc/${process.pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep -c SANDBOX_TEST_CREDENTIAL`,
        'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c SANDBOX_TEST_CREDENTIAL',
        `ls -A ${masked} | wc -l`,
        'ls /proc | grep -cE "^[0-9]+$"',
      ].join('; '));
      const [ownPid, anyPid, maskedEntries, processes] = result.stdoutTail.trim().split('\n').map(Number);
      expect(ownPid).toBe(0);
      expect(anyPid).toBe(0);
      expect(maskedEntries).toBe(0);
      expect(processes).toBeLessThan(10);
    } finally {
      delete process.env.SANDBOX_TEST_CREDENTIAL;
    }
  });

  it('removes network interfaces except loopback when network access is not granted', async () => {
    const isolated = await run('tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\\n" " "');
    expect(isolated.stdoutTail.trim()).toBe('lo');
    const shared = await run('tail -n +3 /proc/net/dev | wc -l', { network: true });
    expect(Number(shared.stdoutTail.trim())).toBeGreaterThan(0);
  });

  it('kills every process in the sandbox on timeout, including ones ignoring SIGTERM', async () => {
    const marker = `sandbox-timeout-${process.pid}-${Date.now()}`;
    const result = await run(`trap "" TERM; (trap "" TERM; exec -a ${marker} sleep 300) & sleep 300`, { timeoutMs: 1_000 });
    expect(result.outcome).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(spawnSync('pgrep', ['-f', marker]).status).toBe(1);
  });

  it('confines repository quality commands run by the quality gate runner', async () => {
    process.env.SANDBOX_GATE_CREDENTIAL = 'gate-credential-value';
    try {
      const quality: RepositoryQualityConfig = {
        setup: [],
        checks: [
          { name: 'probe', command: ['/bin/sh', '-c', `cat /proc/${process.pid}/environ; cat ${masked}/orchestrator.env; env; touch ${root}/escaped; exit 0`], timeoutSeconds: 30 },
        ],
        environment: [],
        documentation: [],
      };
      const runner = new QualityGateRunner({
        quality: () => quality,
        sourceEnvironment: { PATH: '/usr/bin:/bin', HOME: homedir() },
        knownSecrets: [],
        sandbox: new BubblewrapSandbox(sandboxConfig({ readOnlyPaths: ['/usr', '/etc'], maskedPaths: [masked] })),
        readOnlyPaths: () => [masked],
      });
      const report = await runner.run('web', worktree, 'all', new AbortController().signal);
      expect(report.passed).toBe(true);
      const output = report.results[0]?.outputTail ?? '';
      expect(output).not.toContain('gate-credential-value');
      expect(output).not.toContain('ghp_masked');
      expect(output).toContain(`HOME=${sandboxHome}`);
      expect(() => readFileSync(join(root, 'escaped'))).toThrow();
    } finally {
      delete process.env.SANDBOX_GATE_CREDENTIAL;
    }
  });
});
