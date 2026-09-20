import type { OrchestratorConfig } from '../config/schema.js';
import { providerAliasForTier } from '../config/providers.js';
import type { Complexity } from '../intake/planning-contract.js';
import { defaultRouting } from './defaults.js';
import type { Effort, ModelSelection } from '../types/model.js';

export type { Complexity } from '../intake/planning-contract.js';
export type { Effort, ModelSelection } from '../types/model.js';

export { defaultRouting } from './defaults.js';

/** Routing in force: configured overrides replace the built-in default one complexity at a time. */
export function routingFor(config: OrchestratorConfig, complexity: Complexity): { tier: string; effort: Effort } {
  return config.models.routes[complexity] ?? defaultRouting[complexity];
}

/**
 * Resolves one routed choice against configured tiers and providers. Deterministic: the same configuration and the same
 * route always yield the same provider, model, and effort, so an attempt can be reproduced from its evidence.
 */
export function resolveRoute(config: OrchestratorConfig, route: { tier: string; effort: Effort }): ModelSelection {
  const tier = config.models.tiers[route.tier];
  if (tier === undefined) throw new Error(`No model configured for tier: ${route.tier}`);
  const provider = providerAliasForTier(config, route.tier);
  if (provider === undefined) throw new Error(`Tier ${route.tier} must name a provider when several providers are configured`);
  return { provider, tier: route.tier, model: tier.model, effort: route.effort };
}

export function selectModel(config: OrchestratorConfig, complexity: Complexity): ModelSelection {
  return resolveRoute(config, routingFor(config, complexity));
}
