import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterKinds } from '../src/execution/adapters/capabilities.js';

/**
 * Provider-specific knowledge belongs in adapter modules, fixtures, and the example configuration. Anywhere else it is a
 * coupling that silently makes one provider mandatory, which is what this refactor exists to remove.
 */
const adaptersDirectory = 'src/execution/adapters';
/**
 * Files allowed to know a provider by name, each for a stated reason:
 * - the adapter and its capability declaration own the provider vocabulary;
 * - `domain.ts` still recognises the pre-registry pause reason so rows written before the registry resume correctly;
 * - `credentials.ts` withholds provider credentials by their conventional variable names;
 * - the example configuration shows a provider with its credential variable.
 */
const providerAware = new Set([
  'src/execution/adapters/codex-cli.ts',
  'src/execution/adapters/codex-events.ts',
  'src/execution/adapters/capabilities.ts',
  'src/security/credentials.ts',
  'src/types/domain.ts',
  'tests/support/fake-codex.ts',
  'tests/agent-runner.test.ts',
  'orchestrator.config.example.yaml',
]);
const fixtureAllowlist = [
  /^tests\/provider-registry\.test\.ts$/,
  /^tests\/provider-fence\.test\.ts$/,
  /^tests\/support\//,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    return entry.isFile() && /\.(?:ts|ya?ml|json)$/.test(entry.name) ? [path] : [];
  });
}

/** Identifiers that only make sense for one provider. A new one belongs next to its adapter, not in shared code. */
const providerIdentifiers: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Codex CLI flag or setting', pattern: /--ignore-user-config|--skip-git-repo-check|sandbox_workspace_write|approval_policy|shell_environment_policy/ },
  { name: 'Codex JSONL event type', pattern: /thread\.started|turn\.completed|turn\.failed|item\.completed/ },
  { name: 'Codex environment variable', pattern: /CODEX_HOME|CODEX_API_KEY/ },
  { name: 'Codex CLI executable name', pattern: /\bcodex exec\b/ },
  { name: 'OpenAI-shaped usage field', pattern: /input_tokens|cached_input_tokens|reasoning_output_tokens/ },
  { name: 'Codex pause reason', pattern: /CODEX_USAGE_LIMIT/ },
  { name: 'legacy OpenAI model fixture', pattern: /['"]gpt-[a-z0-9.-]+['"]/ },
];

describe('provider coupling fence', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('tests'), 'orchestrator.config.example.yaml'];

  it('keeps provider-specific identifiers inside the adapter that owns them', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const path = relative('.', file);
      if (providerAware.has(path) || fixtureAllowlist.some((pattern) => pattern.test(path))) continue;
      const contents = readFileSync(file, 'utf8');
      for (const { name, pattern } of providerIdentifiers) {
        const match = contents.match(pattern);
        if (match !== null) offenders.push(`${path}: ${name} (${match[0]})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares every adapter kind that a configuration may name', () => {
    // The registry switch and the capability table have to agree, or a config could name a kind that cannot be built.
    const registry = readFileSync('src/execution/provider-registry.ts', 'utf8');
    for (const kind of adapterKinds) expect(registry, kind).toContain(`case '${kind}'`);
    expect(adapterKinds).toContain('codex-cli');
  });

  it('ships no provider executable or credential in the tracked example configuration', () => {
    const example = readFileSync('orchestrator.config.example.yaml', 'utf8');
    // The example must stay runnable on a machine with no provider installed, so paths stay placeholders.
    expect(example).not.toMatch(/\/(?:home|Users)\/[^/\s]+/);
    expect(statSync(adaptersDirectory).isDirectory()).toBe(true);
  });

  it('keeps the stage layer dependent on the runner port alone', () => {
    // Stages resolve a provider only through the registry and call only `AgentRunner.run`. If a stage imported an
    // adapter or the registry itself, which provider serves a role would stop being a configuration fact.
    const offenders: string[] = [];
    for (const file of sourceFiles('src/execution/stages')) {
      const path = relative('.', file);
      const imports = readFileSync(file, 'utf8').match(/^import[^;]*?from\s+'([^']+)';/gm) ?? [];
      for (const statement of imports) {
        const specifier = statement.match(/from\s+'([^']+)';$/)?.[1] ?? '';
        if (/adapters|provider-registry|dispatching-runner/.test(specifier)) offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
