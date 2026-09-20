/** Canonical effort scale. Providers rename these levels through their adapter; they never remove one. */
export const effortValues = ['low', 'medium', 'high', 'max'] as const;

export type Effort = (typeof effortValues)[number];

/**
 * The roles an agent can run as. `implementer` and `fixer` write worktrees, which makes them the roles whose commands
 * execute model-written code; they require a confining provider (see `execution/adapters/capabilities.ts`).
 */
export const agentRoleValues = ['analyzer', 'implementer', 'fixer', 'reviewer'] as const;

export type AgentRole = (typeof agentRoleValues)[number];

/** Roles that write to worktrees and therefore require command confinement. */
export const writeRoleValues: readonly AgentRole[] = ['implementer', 'fixer'];

/** Provider alias addressing one configured provider executable, for example `openai` or `anthropic`. */
export const providerAliasPattern = /^[a-z0-9][a-z0-9-]*$/;

/** One routed model choice. Every field is decided by deterministic policy, never by a model. */
export interface ModelSelection {
  /** Provider alias that runs this selection. */
  provider: string;
  tier: string;
  model: string;
  effort: Effort;
}
