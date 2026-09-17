import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { auditCredentialExposure } from '../src/security/credential-exposure.js';
import { testConfig } from './support/config.js';

describe('credential exposure audit', () => {
  let root: string;
  let home: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'exposure-'));
    home = join(root, 'home');
    mkdirSync(join(root, 'etc'), { mode: 0o755 });
    mkdirSync(home);
    configPath = join(root, 'etc', 'orchestrator.yaml');
    writeFileSync(configPath, 'timezone: Asia/Jakarta\n', { mode: 0o640 });
    chmodSync(join(root, 'etc'), 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function config(overrides: Record<string, unknown>) {
    const base = testConfig();
    return validateConfig({
      timezone: base.timezone,
      schedule: { days: {} },
      linear: { teamKey: 'KEL' },
      models: { ...base.models, tiers: { luna: { model: 'a' }, terra: { model: 'b' }, sol: { model: 'c' } } },
      limits: {},
      orchestrator: { execution: { prepareWorkspaces: true, runAgents: true } },
      workspace: { root: join(root, 'workspaces') },
      repositories: { web: { path: join(root, 'web'), github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }] } } },
      agents: { runner: { executable: '/usr/bin/codex' }, commitAuthor: { name: 'Bot', email: 'bot@example.test' } },
      ...overrides,
    });
  }

  const audit = (overrides: Record<string, unknown>, environment: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://orchestrator:pw@127.0.0.1/db' }) =>
    auditCredentialExposure({ config: config(overrides), configPath, environment, home });

  it('reports nothing for an isolated deployment', async () => {
    expect(await audit({ sandbox: { kind: 'bubblewrap' }, workspace: { root: join(root, 'workspaces'), gitAuthentication: 'github-token' } })).toEqual([]);
  });

  it('reports a disabled sandbox, host Git credentials, readable credential files, and passwordless database access', async () => {
    writeFileSync(join(home, '.git-credentials'), 'https://user:token@github.com\n');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'private');
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'public');
    writeFileSync(join(home, '.ssh', 'known_hosts'), 'github.com');

    const findings = await audit({}, { DATABASE_URL: 'postgres:///orchestrator?host=/run/postgresql' });

    expect(findings.map((finding) => finding.check).sort()).toEqual([
      'credential-file-readable', 'credential-file-readable', 'database-passwordless', 'git-host-credentials', 'sandbox-disabled',
    ]);
    const readableFiles = findings.filter((finding) => finding.check === 'credential-file-readable').map((finding) => finding.message);
    expect(readableFiles.some((message) => message.includes('.git-credentials'))).toBe(true);
    expect(readableFiles.some((message) => message.includes('id_ed25519 '))).toBe(true);
    expect(readableFiles.join('\n')).not.toMatch(/\.pub|known_hosts/);
  });

  it('reports configuration writable by other accounts even when agents are disabled', async () => {
    chmodSync(configPath, 0o666);
    const findings = await audit({ orchestrator: {}, agents: undefined, repositories: {}, workspace: undefined });
    expect(findings).toEqual([{ check: 'config-writable', message: `${configPath} is writable by group or others` }]);
  });

  it('ignores credential files the service user cannot read', async () => {
    if (process.getuid?.() === 0) return;
    const secret = join(root, 'orchestrator.env');
    writeFileSync(secret, 'GITHUB_TOKEN=x', { mode: 0o000 });
    const findings = await audit({
      sandbox: { kind: 'bubblewrap' },
      workspace: { root: join(root, 'workspaces'), gitAuthentication: 'github-token' },
      security: { credentialFiles: [secret] },
    });
    expect(findings).toEqual([]);
  });
});
