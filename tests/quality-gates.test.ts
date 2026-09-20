import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig, type RepositoryQualityConfig } from '../src/config/schema.js';
import { QualityGateRunner } from '../src/execution/quality-gates.js';
import { testConfig } from './support/config.js';

const node = process.execPath;

function quality(overrides: Partial<RepositoryQualityConfig>): RepositoryQualityConfig {
  return { setup: [], checks: [], environment: [], documentation: [], ...overrides };
}

describe('quality gate runner', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'quality-'));
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function runner(config: RepositoryQualityConfig, environment: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
    return new QualityGateRunner({ quality: () => config, sourceEnvironment: environment, knownSecrets: ['orchestrator-secret-value'] });
  }

  it('runs setup then every check in the worktree and reports each outcome', async () => {
    const report = await runner(quality({
      setup: [{ name: 'install', command: [node, '-e', 'require("fs").writeFileSync("installed", "yes")'], timeoutSeconds: 30 }],
      checks: [
        { name: 'lint', command: [node, '-e', 'process.exit(require("fs").existsSync("installed") ? 0 : 3)'], timeoutSeconds: 30 },
        { name: 'test', command: [node, '-e', 'console.error("1 failing"); process.exit(1)'], timeoutSeconds: 30 },
        { name: 'build', command: [node, '-e', 'console.log("built")'], timeoutSeconds: 30 },
      ],
    })).run('web', workspace, 'all', new AbortController().signal);

    expect(report).toMatchObject({ repository: 'web', passed: false, infrastructureError: null, aborted: false });
    expect(report.results.map(({ phase, name, passed, exitCode }) => ({ phase, name, passed, exitCode }))).toEqual([
      { phase: 'setup', name: 'install', passed: true, exitCode: 0 },
      { phase: 'check', name: 'lint', passed: true, exitCode: 0 },
      { phase: 'check', name: 'test', passed: false, exitCode: 1 },
      { phase: 'check', name: 'build', passed: true, exitCode: 0 },
    ]);
    expect(report.results[2]?.outputTail).toContain('1 failing');
  });

  it('skips checks after a failed setup and runs only setup when asked', async () => {
    const config = quality({
      setup: [{ name: 'install', command: [node, '-e', 'process.exit(9)'], timeoutSeconds: 30 }],
      checks: [{ name: 'test', command: [node, '-e', ''], timeoutSeconds: 30 }],
    });
    const report = await runner(config).run('web', workspace, 'all', new AbortController().signal);
    expect(report.passed).toBe(false);
    expect(report.results.map((result) => result.name)).toEqual(['install']);
    expect((await runner(quality({ ...config, setup: [] })).run('web', workspace, 'setup', new AbortController().signal)).results).toEqual([]);
  });

  it('withholds credentials, redacts output, and exposes only allowlisted variables', async () => {
    const source = { PATH: process.env.PATH, LINEAR_API_KEY: 'orchestrator-secret-value', OPENAI_API_KEY: 'sk-other', NODE_ENV: 'test' };
    const report = await runner(quality({
      environment: ['NODE_ENV'],
      checks: [{ name: 'env', command: [node, '-e', 'console.log(JSON.stringify(process.env)); console.log("leak orchestrator-secret-value")'], timeoutSeconds: 30 }],
    }), source).run('web', workspace, 'all', new AbortController().signal);
    const output = report.results[0]?.outputTail ?? '';
    expect(output).toContain('"NODE_ENV":"test"');
    expect(output).toContain('"CI":"true"');
    expect(output).not.toContain('LINEAR_API_KEY');
    expect(output).not.toContain('OPENAI_API_KEY');
    expect(output).toContain('leak [REDACTED]');
  });

  it('reports timeouts as failures, missing executables as infrastructure errors, and aborts', async () => {
    const timedOut = await runner(quality({ checks: [{ name: 'hang', command: [node, '-e', 'setInterval(() => {}, 1000)'], timeoutSeconds: 1 }] }))
      .run('web', workspace, 'all', new AbortController().signal);
    expect(timedOut.results[0]).toMatchObject({ passed: false, outcome: 'timeout' });
    expect(timedOut.infrastructureError).toBeNull();

    const missing = await runner(quality({ checks: [{ name: 'lint', command: [join(workspace, 'no-such-linter')], timeoutSeconds: 30 }] }))
      .run('web', workspace, 'all', new AbortController().signal);
    expect(missing).toMatchObject({ passed: false, infrastructureError: expect.stringContaining('could not start') });

    const controller = new AbortController();
    const running = runner(quality({ checks: [{ name: 'hang', command: [node, '-e', 'setInterval(() => {}, 1000)'], timeoutSeconds: 60 }] }))
      .run('web', workspace, 'all', controller.signal);
    setTimeout(() => controller.abort('shutdown'), 100);
    expect(await running).toMatchObject({ aborted: true, passed: false });
  });
});

describe('agent execution configuration', () => {
  const agents = { runner: { executable: '/usr/local/bin/agent-runner', environment: ['AGENT_HOME'] }, commitAuthor: { name: 'Orchestrator', email: 'orchestrator@example.test' } };
  const repositories = { web: { path: '/srv/web', github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }] } } };

  function configWith(overrides: Record<string, unknown>) {
    const base = testConfig();
    return {
      ...base,
      orchestrator: { ...base.orchestrator, execution: { prepareWorkspaces: true, runAgents: true } },
      workspace: { root: '/srv/workspaces' },
      models: { ...base.models, tiers: { luna: { model: 'a' }, terra: { model: 'b' }, sol: { model: 'c' } } },
      repositories,
      agents,
      ...overrides,
    };
  }

  it('accepts a complete configuration with safe defaults', () => {
    const config = validateConfig(configWith({}));
    expect(config.agents?.runner.timeoutMinutes).toEqual({ analysis: 20, implementation: 60, fix: 45, review: 20 });
    expect(config.agents?.diffPolicy.forbiddenPaths).toContain('.github/**');
    expect(config.repositories.web?.quality.checks[0]).toMatchObject({ timeoutSeconds: 900 });
  });

  it('requires workspaces, agents, checks, routed tiers, and withheld credentials', () => {
    const issues = (input: Record<string, unknown>) => {
      try {
        validateConfig(input);
        return [];
      } catch (error) {
        return (error as { issues: Array<{ message: string }> }).issues.map((issue) => issue.message);
      }
    };
    const base = testConfig();
    expect(issues(configWith({ orchestrator: { ...base.orchestrator, execution: { runAgents: true } } }))).toContain('must be true when orchestrator.execution.runAgents is true');
    expect(issues(configWith({ agents: undefined }))).toContain('is required when orchestrator.execution.runAgents is true');
    expect(issues(configWith({ repositories: { web: { ...repositories.web, quality: {} } } }))).toContain('must define at least one check when orchestrator.execution.runAgents is true');
    expect(issues(configWith({ models: { ...base.models, tiers: { terra: { model: 'b' } } } }))).toEqual(expect.arrayContaining([expect.stringContaining('routed model tier luna')]));
    expect(issues(configWith({ agents: { ...agents, runner: { ...agents.runner, environment: ['LINEAR_API_KEY'] } } }))).toContain('must not expose orchestrator credential LINEAR_API_KEY');
    expect(issues(configWith({ repositories: { web: { ...repositories.web, quality: { ...repositories.web.quality, environment: ['OPENAI_API_KEY'] } } } }))).toContain('must not expose orchestrator credential OPENAI_API_KEY');
    expect(issues(configWith({ agents: { ...agents, runner: { executable: 'codex' } } }))).toContain('must be an absolute path');
    expect(issues(configWith({ repositories: { web: { ...repositories.web, quality: { checks: [{ name: 'test', command: ['a'] }, { name: 'test', command: ['b'] }] } } } }))).toContain('command names must be unique');
  });
});
