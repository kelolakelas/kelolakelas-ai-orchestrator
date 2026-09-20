import type { OrchestratorConfig } from '../config/schema.js';
import type { Complexity, Effort, ModelSelection } from './model-router.js';
import { resolveRoute } from './model-router.js';
import { defaultEscalation } from './defaults.js';

export { defaultEscalation } from './defaults.js';

/** Escalation ladder in force for one complexity: a configured ladder replaces the built-in one wholesale. */
export function escalationLadder(config: OrchestratorConfig, complexity: Complexity): readonly { tier: string; effort: Effort }[] {
  return config.models.escalation[complexity] ?? defaultEscalation[complexity];
}

export function escalationStep(config: OrchestratorConfig, complexity: Complexity, attempt: number): ModelSelection | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > config.limits.maxImplementationAttempts) {
    return undefined;
  }
  const route = escalationLadder(config, complexity)[attempt - 1];
  if (!route) return undefined;
  return resolveRoute(config, route);
}
