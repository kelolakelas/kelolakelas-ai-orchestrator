import type { Complexity } from '../intake/planning-contract.js';
import type { Effort } from '../types/model.js';

/**
 * Built-in routing by complexity, used for every complexity `models.routes` does not override. These are defaults, not
 * policy: a deployment routes models purely through configuration.
 */
export const defaultRouting: Record<Complexity, { tier: string; effort: Effort }> = {
  'very-low': { tier: 'luna', effort: 'medium' },
  low: { tier: 'luna', effort: 'high' },
  medium: { tier: 'terra', effort: 'medium' },
  high: { tier: 'terra', effort: 'high' },
  'very-high': { tier: 'sol', effort: 'medium' },
  critical: { tier: 'sol', effort: 'high' },
};

/** Built-in escalation ladders, used for every complexity `models.escalation` does not override. */
export const defaultEscalation: Record<Complexity, readonly { tier: string; effort: Effort }[]> = {
  'very-low': [{ tier: 'luna', effort: 'medium' }, { tier: 'luna', effort: 'high' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  low: [{ tier: 'luna', effort: 'high' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  medium: [{ tier: 'terra', effort: 'medium' }, { tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }],
  high: [{ tier: 'terra', effort: 'high' }, { tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
  'very-high': [{ tier: 'sol', effort: 'medium' }, { tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
  critical: [{ tier: 'sol', effort: 'high' }, { tier: 'sol', effort: 'max' }],
};

/** Tiers the built-in ladders can reach, so configurations that keep the defaults are validated against them. */
export const defaultRoutedTiers: readonly string[] = [...new Set(Object.values(defaultEscalation).flatMap((routes) => routes.map((route) => route.tier)))];
