import type { OrchestratorConfig } from './schema.js';

/** One provider executable as the orchestrator uses it, whether declared directly or supplied by legacy configuration. */
export interface ResolvedProvider {
  alias: string;
  kind: string;
  executable: string;
  environment: readonly string[];
  /** Provider-specific effort names, empty when the adapter's own map applies. */
  effort: Record<string, string>;
  /** True when the provider came from the pre-registry `agents.runner` block rather than `models.providers`. */
  legacy: boolean;
}

/**
 * Providers in force. `models.providers` is authoritative when it is configured. Otherwise the pre-registry
 * `agents.runner` block supplies a single provider under its own `kind` as the alias, so existing configurations keep
 * working unchanged and record which transport ran them. A `runner` without an executable cannot supply that provider,
 * which validation only permits once `models.providers` names the transport instead.
 */
export function effectiveProviders(config: OrchestratorConfig): ResolvedProvider[] {
  const declared = Object.entries(config.models.providers).map(([alias, provider]) => ({
    alias,
    kind: provider.kind,
    executable: provider.executable,
    environment: provider.environment,
    effort: provider.effort,
    legacy: false,
  }));
  if (declared.length > 0) return declared;
  const runner = config.agents?.runner;
  if (runner?.executable === undefined) return [];
  return [{ alias: runner.kind, kind: runner.kind, executable: runner.executable, environment: runner.environment, effort: {}, legacy: true }];
}

/** Provider serving a tier that names none. Only unambiguous when exactly one provider is in force. */
export function soleProvider(config: OrchestratorConfig): ResolvedProvider | undefined {
  const providers = effectiveProviders(config);
  return providers.length === 1 ? providers[0] : undefined;
}

/**
 * Placeholder for a routing decision taken when no provider is configured at all, which happens only while agents do not
 * run. Validation requires a real provider for every reachable tier before any agent runs, so this value never reaches an
 * adapter; it exists so a routing decision is always a complete record of what was chosen.
 */
export const unconfiguredProvider = 'unconfigured';

/**
 * The provider alias that serves a tier, or `undefined` when several providers are configured and the tier names none.
 * Configuration-first: an explicit `provider` on the tier always wins, and a single provider in force needs no repetition.
 */
export function providerAliasForTier(config: OrchestratorConfig, tier: string): string | undefined {
  const declared = config.models.tiers[tier]?.provider;
  if (declared !== undefined) return declared;
  const providers = effectiveProviders(config);
  if (providers.length === 0) return unconfiguredProvider;
  return providers.length === 1 ? providers[0]?.alias : undefined;
}

/** Roles that route through a provider, and the tiers they can reach. Used to prove every role has a usable provider. */
export function providerForTier(config: OrchestratorConfig, tier: string): ResolvedProvider | undefined {
  const alias = providerAliasForTier(config, tier);
  return alias === undefined ? undefined : effectiveProviders(config).find((provider) => provider.alias === alias);
}
