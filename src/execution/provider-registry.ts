import type { OrchestratorConfig } from '../config/schema.js';
import { effectiveProviders, type ResolvedProvider } from '../config/providers.js';
import type { ModelSelection } from '../types/model.js';
import { CodexCliAdapter } from './adapters/codex-cli.js';
import { CliAdapter } from './adapters/cli.js';
import { adapterCapabilitiesOf, effectiveConfinement, resolveEffortMap, type CommandConfinement } from './adapters/capabilities.js';
import type { AgentRunner } from './agent-runner.js';
import type { CommandSandbox } from './sandbox.js';

/** Variables every runner process needs, whatever provider it is. Credentials arrive only through provider environment. */
export const baseRunnerEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME'] as const;

export interface ProviderRuntimeOptions {
  /** Private directory for per-run schema and result files, outside every agent-writable directory. */
  scratchRoot: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  /**
   * The orchestrator's command sandbox, already verified at startup. A `cli` provider's only confinement comes from it,
   * because a declaratively configured client cannot be trusted to confine the commands the model issues.
   */
  sandbox: CommandSandbox;
  maxResultBytes: number;
  maxEventBytes: number;
  knownSecrets: readonly string[];
  clock?: () => Date;
}

export interface ProviderHandle {
  alias: string;
  kind: string;
  executable: string;
  confinement: CommandConfinement;
  runner: AgentRunner;
}

/** One provider ready to run: its adapter, plus the confinement that adapter actually provides. */
export interface ProviderRegistry {
  handles: readonly ProviderHandle[];
  /** The adapter that runs one routed selection, or `undefined` when no provider serves it. */
  forSelection(selection: ModelSelection): ProviderHandle | undefined;
  /** The only provider in force, for evidence when a selection named none. */
  sole(): ProviderHandle | undefined;
}

const createAdapter = (provider: ResolvedProvider, options: ProviderRuntimeOptions): AgentRunner => {
  const shared = {
    ...options,
    executable: provider.executable,
    extraEnvironment: provider.environment,
    baseEnvironment: baseRunnerEnvironment,
  };
  switch (provider.kind) {
    case 'codex-cli':
      return new CodexCliAdapter(shared);
    case 'cli': {
      const transport = provider.cli;
      // Validated configuration cannot reach here without one, and the legacy shorthand cannot select `cli` at all.
      if (transport === undefined) throw new Error(`Provider ${provider.alias} uses kind cli but declares no command line`);
      return new CliAdapter({
        ...shared,
        // A client's effort names are unverifiable from here, so the provider's map is authoritative and the adapter
        // holds none of its own. An unmapped level falls back to its canonical name.
        effort: resolveEffortMap(adapterCapabilitiesOf('cli'), provider.effort),
        transport,
      });
    }
    default:
      // Unreachable through validated configuration; kept so a new capability entry cannot run unadapted.
      throw new Error(`No adapter implementation for agent runner kind: ${provider.kind}`);
  }
};

/**
 * Builds the adapters a configuration needs. A provider is built once and shared by every role that routes to it, so
 * confinement and environment handling cannot differ between roles using the same provider.
 */
export function createProviderRegistry(config: OrchestratorConfig, options: ProviderRuntimeOptions): ProviderRegistry {
  const handles = effectiveProviders(config).map((provider) => toHandle(provider, config, options));
  const legacy = config.agents?.runner;
  if (handles.length === 0 && legacy?.executable !== undefined) {
    // No provider was declared, but agents run: the pre-registry `agents.runner` block is the provider in force.
    handles.push(toHandle({ alias: legacy.kind, kind: legacy.kind, executable: legacy.executable, environment: legacy.environment, effort: {}, legacy: true }, config, options));
  }
  return {
    handles,
    forSelection: (selection) => handles.find((handle) => handle.alias === selection.provider) ?? (handles.length === 1 ? handles[0] : undefined),
    sole: () => (handles.length === 1 ? handles[0] : undefined),
  };
}

function toHandle(provider: ResolvedProvider, config: OrchestratorConfig, options: ProviderRuntimeOptions): ProviderHandle {
  return {
    alias: provider.alias,
    kind: provider.kind,
    executable: provider.executable,
    // Confinement is always derived from the adapter's own guarantee and this sandbox, never declared in configuration.
    confinement: effectiveConfinement(adapterCapabilitiesOf(provider.kind), config.sandbox.kind),
    runner: createAdapter(provider, options),
  };
}
