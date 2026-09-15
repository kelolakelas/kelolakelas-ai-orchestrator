import type { OrchestratorConfig } from '../config/schema.js';
import type { Complexity } from '../intake/planning-contract.js';

export type { Complexity } from '../intake/planning-contract.js';
export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface ModelSelection {
  tier: string;
  model: string;
  effort: Effort;
}

const defaultRouting: Record<Complexity, { tier: string; effort: Effort }> = {
  'very-low': { tier: 'luna', effort: 'medium' },
  low: { tier: 'luna', effort: 'high' },
  medium: { tier: 'terra', effort: 'medium' },
  high: { tier: 'terra', effort: 'high' },
  'very-high': { tier: 'sol', effort: 'medium' },
  critical: { tier: 'sol', effort: 'high' },
};

export function selectModel(config: OrchestratorConfig, complexity: Complexity): ModelSelection {
  const route = defaultRouting[complexity];
  const configuredTier = config.models.tiers[route.tier];
  if (!configuredTier) {
    throw new Error(`No model configured for tier: ${route.tier}`);
  }
  return { tier: route.tier, model: configuredTier.model, effort: route.effort };
}
