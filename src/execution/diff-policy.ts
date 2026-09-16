import type { AgentsConfig } from '../config/schema.js';
import { detectSecrets } from './secrets.js';

export type DiffPolicy = AgentsConfig['diffPolicy'];

export interface ChangedFile {
  path: string;
  /** Git status letter: A, M, D, or T (type change). Renames are reported as a delete plus an add. */
  status: string;
  /** Mode after the change; `000000` for deletions. */
  mode: string;
  /** Null for binary content. */
  addedLines: number | null;
  deletedLines: number | null;
}

export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

export interface RepositoryChanges {
  repository: string;
  files: ChangedFile[];
  addedLines: AddedLine[];
  /** Added lines were not read because the diff already exceeds the size limit. */
  patchSkipped: boolean;
}

export type DiffViolationRule =
  | 'unchanged'
  | 'too-many-files'
  | 'too-many-lines'
  | 'too-many-unplanned-files'
  | 'binary-file'
  | 'forbidden-path'
  | 'generated-path'
  | 'symlink'
  | 'submodule'
  | 'secret';

export interface DiffViolation {
  repository: string;
  rule: DiffViolationRule;
  path: string | null;
  detail: string;
}

export interface DiffEvidence {
  repository: string;
  changedFiles: number;
  addedLines: number;
  deletedLines: number;
  binaryFiles: number;
  unplannedFiles: string[];
  paths: string[];
}

export interface DiffEvaluation {
  violations: DiffViolation[];
  evidence: DiffEvidence[];
}

/**
 * Compiles a path glob: `**` matches any number of path segments (including none when followed by `/`), `*` and `?`
 * match within one segment. Patterns are anchored to the repository root.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] as string;
    if (character === '*' && glob[index + 1] === '*') {
      const followedBySlash = glob[index + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function isPlanned(path: string, planned: readonly string[]): boolean {
  return planned.some((entry) => {
    const normalized = entry.replace(/\/+$/, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

/**
 * Decides whether agent changes may be committed. `required` repositories must change; the change set as a whole must
 * not be empty. Findings name the rule and path but never include a matched secret.
 */
export function evaluateChanges(input: {
  changes: readonly RepositoryChanges[];
  policy: DiffPolicy;
  /** Repositories that must contain changes, for example every repository in an implementation plan. */
  required: readonly string[];
  /** Paths named by the accepted plan, per repository. */
  plannedPaths: Readonly<Record<string, readonly string[]>>;
  knownSecrets: readonly string[];
}): DiffEvaluation {
  const { policy } = input;
  const violations: DiffViolation[] = [];
  const evidence: DiffEvidence[] = [];

  if (input.changes.every((repository) => repository.files.length === 0)) {
    violations.push({ repository: '*', rule: 'unchanged', path: null, detail: 'the agent produced no changes' });
  }

  for (const repository of input.changes) {
    const add = (rule: DiffViolationRule, path: string | null, detail: string) => violations.push({ repository: repository.repository, rule, path, detail });
    const planned = input.plannedPaths[repository.repository] ?? [];
    const addedLines = repository.files.reduce((total, file) => total + (file.addedLines ?? 0), 0);
    const deletedLines = repository.files.reduce((total, file) => total + (file.deletedLines ?? 0), 0);
    const unplannedFiles = repository.files.map((file) => file.path).filter((path) => !isPlanned(path, planned));
    evidence.push({
      repository: repository.repository,
      changedFiles: repository.files.length,
      addedLines,
      deletedLines,
      binaryFiles: repository.files.filter((file) => file.addedLines === null).length,
      unplannedFiles,
      paths: repository.files.map((file) => file.path),
    });

    if (repository.files.length === 0 && input.required.includes(repository.repository)) {
      add('unchanged', null, 'the plan requires changes in this repository');
    }
    if (repository.files.length > policy.maxChangedFiles) {
      add('too-many-files', null, `${repository.files.length} files changed; limit is ${policy.maxChangedFiles}`);
    }
    if (addedLines + deletedLines > policy.maxChangedLines) {
      add('too-many-lines', null, `${addedLines + deletedLines} lines changed; limit is ${policy.maxChangedLines}`);
    }
    if (unplannedFiles.length > policy.maxUnplannedFiles) {
      add('too-many-unplanned-files', null, `${unplannedFiles.length} files outside the accepted plan; limit is ${policy.maxUnplannedFiles}`);
    }

    for (const file of repository.files) {
      if (matchesAnyGlob(file.path, policy.forbiddenPaths)) add('forbidden-path', file.path, 'path is protected configuration');
      if (file.status !== 'D' && matchesAnyGlob(file.path, policy.generatedPaths)) add('generated-path', file.path, 'generated or build output must not be committed');
      if (file.mode === '120000') add('symlink', file.path, 'symbolic links are not accepted');
      if (file.mode === '160000') add('submodule', file.path, 'submodule changes are not accepted');
      if (file.status !== 'D' && file.addedLines === null && !matchesAnyGlob(file.path, policy.allowedBinaryPaths)) {
        add('binary-file', file.path, 'binary content is not accepted');
      }
    }

    for (const line of repository.addedLines) {
      for (const rule of detectSecrets(line.text, input.knownSecrets)) {
        add('secret', line.path, `line ${line.line} matches ${rule}`);
      }
    }
  }
  return { violations, evidence };
}

export function describeViolations(violations: readonly DiffViolation[], limit = 20): string {
  const listed = violations.slice(0, limit).map((violation) => `${violation.repository}${violation.path === null ? '' : `:${violation.path}`} ${violation.rule} (${violation.detail})`);
  if (violations.length > limit) listed.push(`and ${violations.length - limit} more`);
  return listed.join('; ');
}
