/**
 * The contract between configuration and the declarative `cli` adapter. It lives in its own leaf module because both
 * configuration validation and the adapter need it, and configuration must never import process-spawning code.
 *
 * Nothing here names a provider. An operator supplies the argument template, where the result comes from, and how to read
 * usage from it; the adapter only performs the substitutions and reads the declared paths.
 */

/**
 * Placeholders an argument template may use. Unknown placeholders are rejected when configuration is validated, so a
 * typo fails at startup rather than reaching a provider as a stray argument.
 */
export const cliPlaceholders = [
  /** Model identifier from the routed tier. */
  '{model}',
  /** Provider-specific effort name resolved through the provider's `effort` map. */
  '{effort}',
  /** The result schema as an inline JSON string. */
  '{schema}',
  /** Absolute path of a file holding the result schema, for clients that read it from disk. */
  '{schemaFile}',
  /** Absolute path the client should write its result to, for clients that report through a file. */
  '{resultFile}',
  /** Absolute path of the task worktree, which is also the working directory of the run. */
  '{taskDirectory}',
  /** The prompt. Only used when the prompt is delivered as an argument rather than on stdin. */
  '{prompt}',
] as const;

export type CliPlaceholder = (typeof cliPlaceholders)[number];

const placeholderPattern = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;

/** Every `{name}` occurrence in one argument, whether or not it is known. */
export function cliPlaceholdersIn(argument: string): string[] {
  return argument.match(placeholderPattern) ?? [];
}

/**
 * Reads a dotted path from a parsed JSON document. An empty path returns the document itself. Returns `undefined` when
 * any segment is missing, so a declared path that the provider did not emit is treated as absent rather than as null.
 */
export function readJsonPath(document: unknown, path: string): unknown {
  if (path === '') return document;
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Reads a non-negative integer from a value, tolerating numeric strings. Returns 0 for anything else. */
export function readTokenCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}
