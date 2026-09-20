import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { effectiveProviders, providerAliasForTier, soleProvider, unconfiguredProvider } from '../src/config/providers.js';
import { adapterCapabilitiesOf, effectiveConfinement, isAdapterKind, resolveEffortMap } from '../src/execution/adapters/capabilities.js';
import { createProviderRegistry } from '../src/execution/provider-registry.js';
import { DispatchingAgentRunner } from '../src/execution/dispatching-runner.js';
import { NoSandbox, type CommandSandbox } from '../src/execution/sandbox.js';
import { roleModel } from '../src/execution/stages/stage-support.js';
import { escalationStep } from '../src/routing/escalation-policy.js';
import { resolveRoute, selectModel } from '../src/routing/model-router.js';
import { testConfig } from './support/config.js';
import { createFakeCodex } from './support/fake-codex.js';

/** A workspace root under a temporary directory, so validation sees the paths the schema requires. */
const workspaceRoot = join(tmpdir(), 'kelolakelas-registry-tests');

function configWith(models: Record<string, unknown>, extra: Record<string, unknown> = {}, agents: Record<string, unknown> = {}) {
  const base = testConfig();
  return validateConfig({
    timezone: base.timezone,
    schedule: { days: {} },
    linear: { teamKey: 'KEL' },
    limits: {},
    orchestrator: { execution: { prepareWorkspaces: true, runAgents: true } },
    workspace: { root: workspaceRoot },
    repositories: { web: { path: '/srv/kelolakelas-web', github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }] } } },
    ...extra,
    agents: { runner: { kind: 'codex-cli', executable: '/usr/local/bin/codex' }, commitAuthor: { name: 'Bot', email: 'bot@example.test' }, ...agents },
    models: {
      analyzer: { tier: 'terra', effort: 'high' },
      reviewer: { tier: 'terra', effort: 'high' },
      tiers: { luna: { model: 'quick-model' }, terra: { model: 'balanced-model' }, sol: { model: 'deep-model' } },
      ...models,
    },
  });
}

describe('provider resolution', () => {
  it('falls back to the legacy runner when no provider is declared, keeping existing configurations working', () => {
    // `testConfig` routes without running agents, so no provider is in force at all.
    const unroutedConfig = testConfig();
    expect(unroutedConfig.agents).toBeUndefined();
    expect(effectiveProviders(unroutedConfig)).toEqual([]);

    const withRunner = configWith({});
    const providers = effectiveProviders(withRunner);
    expect(providers).toEqual([expect.objectContaining({ alias: 'codex-cli', kind: 'codex-cli', legacy: true })]);
    expect(soleProvider(withRunner)?.alias).toBe('codex-cli');
    // A single provider in force serves every tier without the tier repeating it.
    expect(selectModel(withRunner, 'medium')).toMatchObject({ provider: 'codex-cli', tier: 'terra' });
  });

  it('prefers declared providers over the legacy runner so both can be migrated one tier at a time', () => {
    const config = configWith({ providers: { fast: { kind: 'codex-cli', executable: '/usr/local/bin/codex' } } });
    expect(effectiveProviders(config)).toEqual([expect.objectContaining({ alias: 'fast', legacy: false })]);
  });

  it('reports the explicit provider of a tier and refuses to guess when several are configured', () => {
    const config = configWith({
      providers: {
        alpha: { kind: 'codex-cli', executable: '/usr/local/bin/alpha' },
        beta: { kind: 'codex-cli', executable: '/usr/local/bin/beta' },
      },
      tiers: {
        luna: { model: 'quick-model', provider: 'alpha' },
        terra: { model: 'balanced-model', provider: 'beta' },
        sol: { model: 'deep-model', provider: 'beta' },
      },
    });
    expect(providerAliasForTier(config, 'terra')).toBe('beta');
    expect(resolveRoute(config, { tier: 'luna', effort: 'low' })).toEqual({ provider: 'alpha', tier: 'luna', model: 'quick-model', effort: 'low' });
    expect(soleProvider(config)).toBeUndefined();
  });

  it('records that routing ran with no provider configured, instead of inventing one', () => {
    expect(selectModel(testConfig(), 'medium')).toMatchObject({ provider: unconfiguredProvider });
  });
});

describe('routing configuration', () => {
  it('lets configuration replace routing and escalation ladders without touching code', () => {
    const config = configWith({
      routes: { medium: { tier: 'sol', effort: 'max' } },
      escalation: { medium: [{ tier: 'luna', effort: 'low' }, { tier: 'sol', effort: 'high' }] },
    });
    // A configured route replaces the default for that complexity only.
    expect(selectModel(config, 'medium')).toMatchObject({ tier: 'sol', effort: 'max' });
    expect(selectModel(config, 'critical')).toMatchObject({ tier: 'sol', effort: 'high' });
    // A configured ladder replaces the default ladder for that complexity only.
    expect(escalationStep(config, 'medium', 1)).toMatchObject({ tier: 'luna', effort: 'low' });
    expect(escalationStep(config, 'medium', 3)).toBeUndefined();
    expect(escalationStep(config, 'very-low', 1)).toBeDefined();
  });

  it('routes a role to its own tier through models.roles, defaulting to the analyzer and reviewer entries', () => {
    const config = configWith({ roles: { reviewer: { tier: 'sol', effort: 'max' } } });
    expect(roleModel(config, 'analyzer')).toMatchObject({ tier: 'terra', effort: 'high' });
    expect(roleModel(config, 'reviewer')).toMatchObject({ tier: 'sol', effort: 'max' });
  });
});

describe('capability contract', () => {
  it('declares confinement per adapter and honours the configured sandbox', () => {
    expect(isAdapterKind('codex-cli')).toBe(true);
    expect(isAdapterKind('not-a-provider')).toBe(false);
    expect(adapterCapabilitiesOf('codex-cli')).toMatchObject({ ownConfinement: 'provider-sandbox', wrappable: false });

    // Codex enforces its own sandbox, so the orchestrator never nests bubblewrap around it.
    expect(effectiveConfinement(adapterCapabilitiesOf('codex-cli'), 'none')).toBe('provider-sandbox');
    expect(effectiveConfinement(adapterCapabilitiesOf('codex-cli'), 'bubblewrap')).toBe('provider-sandbox');
    // An adapter with no confinement of its own is only confined when bubblewrap can wrap it.
    expect(effectiveConfinement({ ownConfinement: 'none', wrappable: true, effortMap: {} }, 'bubblewrap')).toBe('bwrap');
    expect(effectiveConfinement({ ownConfinement: 'none', wrappable: true, effortMap: {} }, 'none')).toBe('none');
    expect(effectiveConfinement({ ownConfinement: 'none', wrappable: false, effortMap: {} }, 'bubblewrap')).toBe('none');
  });

  it('maps the canonical effort scale onto a provider vocabulary and lets configuration override it', () => {
    // Codex renames `max`; the other rungs coincide.
    expect(resolveEffortMap(adapterCapabilitiesOf('codex-cli'))).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'xhigh' });
    expect(resolveEffortMap(adapterCapabilitiesOf('codex-cli'), { high: 'H', max: 'M' })).toEqual({ low: 'low', medium: 'medium', high: 'H', max: 'M' });
  });

  it('cannot be given a capability by configuration, and rejects kinds it does not implement', () => {
    // An unimplemented kind is rejected by validation, so a capability can never be claimed by configuration.
    expect(() => configWith({ providers: { odd: { kind: 'hand-written', executable: '/usr/local/bin/odd' } } })).toThrow();
    // The legacy runner kind is validated the same way, so it cannot name an unimplemented adapter either.
    expect(() => configWith({}, {}, { runner: { kind: 'hand-written', executable: '/usr/local/bin/odd' } })).toThrow();
  });

  it('rejects a tier that names no provider while several are configured', () => {
    expect(() => configWith({
      providers: {
        alpha: { kind: 'codex-cli', executable: '/usr/local/bin/alpha' },
        beta: { kind: 'codex-cli', executable: '/usr/local/bin/beta' },
      },
    })).toThrow(/must name a provider because more than one provider is configured/);
  });

  it('rejects a tier or role that names something that is not configured', () => {
    expect(() => configWith({ providers: { alpha: { kind: 'codex-cli', executable: '/usr/local/bin/alpha' } }, tiers: { luna: { model: 'quick-model', provider: 'missing' }, terra: { model: 'balanced-model' }, sol: { model: 'deep-model' } } }))
      .toThrow(/must reference a configured provider alias: missing/);
    expect(() => configWith({ roles: { reviewer: { tier: 'absent', effort: 'high' } } }))
      .toThrow(/must reference a configured model tier: absent/);
  });

  it('withholds every provider credential from repository commands, whichever provider is configured', () => {
    const repository = (environment: string[]) => configWith({}, {
      repositories: { web: { path: '/srv/kelolakelas-web', github: 'kelolakelas/kelolakelas-web', quality: { checks: [{ name: 'test', command: ['npm', 'test'] }], environment } } },
    });
    // Any provider credential, not only the Codex ones, is withheld from commands that execute model-written code.
    expect(() => repository(['ANTHROPIC_API_KEY'])).toThrow(/must not expose orchestrator credential ANTHROPIC_API_KEY/);
    expect(() => repository(['GEMINI_API_KEY'])).toThrow(/must not expose orchestrator credential GEMINI_API_KEY/);
    expect(() => repository(['PATH'])).not.toThrow();
  });
});

describe('provider registry', () => {
  let fake: ReturnType<typeof createFakeCodex>;
  let scratch: string;

  beforeEach(() => {
    fake = createFakeCodex();
    scratch = mkdtempSync(join(tmpdir(), 'registry-'));
  });

  afterEach(() => {
    fake.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  function registry(config: Parameters<typeof createProviderRegistry>[0], sandbox: CommandSandbox = new NoSandbox()) {
    return createProviderRegistry(config, {
      scratchRoot: join(scratch, 'runner'),
      sourceEnvironment: { PATH: process.env.PATH },
      sandbox,
      maxResultBytes: 64 * 1024,
      maxEventBytes: 1024 * 1024,
      knownSecrets: [],
    });
  }

  /** One `cli` provider, whose confinement is the only kind that depends on the orchestrator's own sandbox. */
  function cliConfig(sandbox: Record<string, unknown> = {}) {
    return configWith(
      {
        providers: {
          any: {
            kind: 'cli',
            executable: '/usr/local/bin/model-client',
            cli: { args: ['--model', '{model}', '--schema', '{schema}', '--result', '{resultFile}'], result: { source: 'stdout', path: 'structured_output' } },
          },
        },
      },
      { sandbox },
    );
  }

  it('derives a cli provider confinement from the orchestrator sandbox, never from configuration', () => {
    // Confinement is a property of the configuration and its capability, so it never reads the injected instance.
    const unwrapped = registry(cliConfig(), new NoSandbox());
    const wrapped = registry(cliConfig({ kind: 'bubblewrap' }), new NoSandbox());
    expect(unwrapped.handles[0]?.confinement).toBe('none');
    expect(wrapped.handles[0]?.confinement).toBe('bwrap');
    // Only the orchestrator's own configured sandbox confers confinement here; an operator cannot assert one.
    expect(wrapped.handles[0]?.confinement).not.toBe('provider-sandbox');
  });

  it('refuses to serve a writing role from an unconfined cli provider, at configuration time', () => {
    // `testConfig` leaves the command sandbox at `none`, so this provider confines nothing.
    const provider = {
      kind: 'cli',
      executable: '/usr/local/bin/model-client',
      cli: { args: ['--model', '{model}', '--schema', '{schema}', '--result', '{resultFile}'], result: { source: 'stdout', path: '' } },
    };
    // A role names a tier; the tier names the provider, which is why this is where the contract is enforced.
    const routed = { providers: { any: provider }, tiers: { luna: { model: 'quick-model' }, terra: { model: 'balanced-model', provider: 'any' }, sol: { model: 'deep-model' } }, roles: { fixer: { tier: 'terra', effort: 'high' } } };
    // The provider itself is fine and resolves to no confinement; it is the writing role that configuration refuses.
    expect(registry(cliConfig()).handles[0]?.confinement).toBe('none');
    expect(() => configWith(routed)).toThrow(/writes code, so provider any/);
    // The same provider is accepted once the orchestrator's command sandbox can confine it.
    const confined = configWith(routed, { sandbox: { kind: 'bubblewrap' } });
    expect(confined.models.roles['fixer']?.tier).toBe('terra');
  });

  it('builds one adapter per configured provider and dispatches a selection to its own provider', () => {
    const config = configWith({
      providers: {
        primary: { kind: 'codex-cli', executable: fake.executable },
        secondary: { kind: 'codex-cli', executable: join(scratch, 'missing') },
      },
      tiers: {
        luna: { model: 'quick-model', provider: 'primary' },
        terra: { model: 'balanced-model', provider: 'primary' },
        sol: { model: 'deep-model', provider: 'secondary' },
      },
    });
    const providers = registry(config);
    expect(providers.handles.map((handle) => handle.alias)).toEqual(['primary', 'secondary']);
    expect(providers.handles.every((handle) => handle.confinement === 'provider-sandbox')).toBe(true);

    const runner = new DispatchingAgentRunner(providers);
    expect(runner).toBeDefined();
    // A selection naming a provider that was never configured cannot silently run somewhere else.
    expect(providers.forSelection({ provider: 'absent', tier: 'terra', model: 'm', effort: 'low' })).toBeUndefined();
  });

  it('refuses to dispatch an unroutable selection when several providers are configured', async () => {
    const config = configWith({
      providers: {
        primary: { kind: 'codex-cli', executable: fake.executable },
        secondary: { kind: 'codex-cli', executable: join(scratch, 'missing') },
      },
      tiers: {
        luna: { model: 'quick-model', provider: 'primary' },
        terra: { model: 'balanced-model', provider: 'primary' },
        sol: { model: 'deep-model', provider: 'secondary' },
      },
    });
    const runner = new DispatchingAgentRunner(registry(config));
    const result = await runner.run({
      role: 'analyzer',
      model: { provider: 'absent', tier: 'terra', model: 'balanced-model', effort: 'high' },
      prompt: 'PROMPT',
      taskDirectory: scratch,
      access: 'read-only',
      resultSchema: z.object({ ok: z.boolean() }),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'failed', message: expect.stringContaining('No provider serves model selection absent/terra') });
  });

  it('serves a selection that names no provider from the single provider in force', () => {
    const config = configWith({ providers: { only: { kind: 'codex-cli', executable: fake.executable } } });
    const providers = registry(config);
    // Validation already refuses ambiguous routing, so a lone provider may safely serve an unrouted tier.
    expect(providers.forSelection({ provider: unconfiguredProvider, tier: 'terra', model: 'balanced-model', effort: 'high' })?.alias).toBe('only');
  });

  it('builds the legacy runner as the single provider so no configuration is left unrunnable', () => {
    const providers = registry(configWith({}));
    expect(providers.handles).toHaveLength(1);
    expect(providers.sole()?.alias).toBe('codex-cli');
  });

  it('lets an operator finish the migration by dropping the legacy runner executable once providers are declared', () => {
    // The deprecation warning tells operators to declare models.providers; making the executable optional
    // is what lets them actually delete the block afterwards instead of keeping it forever.
    const config = configWith(
      { providers: { primary: { kind: 'codex-cli', executable: fake.executable } } },
      {},
      { runner: { kind: 'codex-cli' } },
    );
    expect(config.agents?.runner.executable).toBeUndefined();
    expect(effectiveProviders(config).map((provider) => provider.alias)).toEqual(['primary']);
    // A runner without an executable cannot become a provider, so it never doubles the declared one.
    expect(registry(config).handles.map((handle) => handle.alias)).toEqual(['primary']);
  });

  it('still demands a transport to run agents: declared providers, or a legacy runner executable', () => {
    let issues: z.ZodIssue[] = [];
    try {
      configWith({}, {}, { runner: { kind: 'codex-cli' } });
    } catch (error) {
      issues = (error as z.ZodError).issues;
    }
    expect(issues).toContainEqual(expect.objectContaining({
      path: ['agents', 'runner', 'executable'],
      message: 'is required when orchestrator.execution.runAgents is true and models.providers is empty',
    }));
  });
});
