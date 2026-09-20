import type { Effort } from '../../types/model.js';

/** Confinement actually in force for the commands a model issues while it works on a task. */
export type CommandConfinement = 'provider-sandbox' | 'bwrap' | 'none';

/**
 * What one adapter kind guarantees, declared next to its implementation. Configuration can narrow a capability but never
 * widen it: an adapter that cannot confine commands is never allowed to serve a role that writes code, however the
 * operator configures it.
 */
export interface AdapterCapabilities {
  /**
   * Confinement the adapter provides by itself. `provider-sandbox` means every model-issued command is confined by the
   * provider, which is the posture the orchestrator's security model assumes (ADR 0006, 0008).
   */
  ownConfinement: 'provider-sandbox' | 'none';
  /**
   * Whether the orchestrator may wrap this adapter in its own command sandbox. An adapter that already runs its own
   * sandbox is not wrappable: nesting one sandbox inside another is unsupported and would silently weaken both.
   */
  wrappable: boolean;
  /** Provider-specific names for canonical effort levels. Providers may rename levels, never remove them. */
  effortMap: Partial<Record<Effort, string>>;
}

/**
 * Adapter capabilities by `kind`. This table holds no adapter implementation imports so configuration validation can
 * read it without loading process-spawning code.
 */
export const adapterCapabilities: Readonly<Record<string, AdapterCapabilities>> = {
  'codex-cli': {
    // `codex exec --sandbox read-only|workspace-write` confines every model-issued command and is what the security
    // model relies on. Codex's own sandbox cannot be nested inside the orchestrator's, so it is not wrappable.
    ownConfinement: 'provider-sandbox',
    wrappable: false,
    effortMap: { max: 'xhigh' },
  },
};

export const adapterKinds = Object.keys(adapterCapabilities);

export function isAdapterKind(kind: string): boolean {
  return Object.hasOwn(adapterCapabilities, kind);
}

export function adapterCapabilitiesOf(kind: string): AdapterCapabilities {
  const capabilities = adapterCapabilities[kind];
  if (capabilities === undefined) throw new Error(`Unknown agent runner kind: ${kind}. Known kinds: ${adapterKinds.join(', ')}`);
  return capabilities;
}

/** Confinement a provider kind effectively gives, from its own guarantee and the orchestrator's command sandbox. */
export function effectiveConfinement(capabilities: AdapterCapabilities, sandboxKind: 'none' | 'bubblewrap'): CommandConfinement {
  if (capabilities.ownConfinement === 'provider-sandbox') return 'provider-sandbox';
  return sandboxKind === 'bubblewrap' && capabilities.wrappable ? 'bwrap' : 'none';
}

/** Canonical effort scale resolved to the names one provider accepts. Unmapped levels keep their canonical name. */
export function resolveEffortMap(capabilities: AdapterCapabilities, overrides: Partial<Record<Effort, string>> = {}): Record<Effort, string> {
  const canonical: readonly Effort[] = ['low', 'medium', 'high', 'max'];
  return Object.fromEntries(canonical.map((effort) => [effort, overrides[effort] ?? capabilities.effortMap[effort] ?? effort])) as Record<Effort, string>;
}

/**
 * Roles that write to worktrees. Their commands execute code the model itself wrote, so they require confinement and are
 * never served by an adapter whose effective confinement is `none`.
 */
export const writeRoles: readonly string[] = ['implementer', 'fixer'];
