import type { OrchestratorConfig } from '../config/schema.js';
import type { Complexity, Effort, ModelSelection } from './model-router.js';

const escalation: Record<Complexity, readonly { tier: string; effort: Effort }[]> = {
  'very-low': [{ tier: 'luna', effort: 'medium' }, { tier: 'luna', effort: 'high' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  low: [{ tier: 'luna', effort: 'high' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  medium: [{ tier: 'terra', effort: 'medium' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  high: [{ tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
  'very-high': [{ tier: 'sol', effort: 'medium' }, { tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
  critical: [{ tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
};

export function escalationStep(config: OrchestratorConfig, complexity: Complexity, attempt: number): ModelSelection | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > config.limits.maxImplementationAttempts) {
    return undefined;
  }
  const route = escalation[complexity][attempt - 1];
  if (!route) return undefined;
  const configuredTier = config.models.tiers[route.tier];
  if (!configuredTier) throw new Error(`No model configured for tier: ${route.tier}`);
  return { tier: route.tier, model: configuredTier.model, effort: route.effort };
}
