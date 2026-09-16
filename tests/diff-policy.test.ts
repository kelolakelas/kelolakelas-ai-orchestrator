import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { evaluateChanges, globToRegExp, matchesAnyGlob, type ChangedFile, type RepositoryChanges } from '../src/execution/diff-policy.js';
import { collectKnownSecrets, detectSecrets, redactSecrets } from '../src/execution/secrets.js';
import { parseAddedLines, parseNumstat, parseRawDiff } from '../src/execution/workspace-changes.js';
import { testConfig } from './support/config.js';

const policy = validateConfig({
  ...testConfig(),
  agents: { runner: { executable: '/usr/bin/codex' }, commitAuthor: { name: 'Bot', email: 'bot@example.test' }, diffPolicy: { maxChangedFiles: 3, maxChangedLines: 20, maxUnplannedFiles: 1 } },
}).agents!.diffPolicy;

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'M', mode: '100644', addedLines: 1, deletedLines: 0, ...overrides };
}

function evaluate(changes: RepositoryChanges[], required: string[] = ['web'], planned: Record<string, string[]> = { web: ['src'] }) {
  return evaluateChanges({ changes, policy, required, plannedPaths: planned, knownSecrets: ['s3cr3t-orchestrator-value'] });
}

function rules(result: ReturnType<typeof evaluate>) {
  return result.violations.map((violation) => `${violation.rule}${violation.path === null ? '' : `:${violation.path}`}`);
}

describe('path globs', () => {
  it('matches directory wildcards anchored at the repository root', () => {
    expect(globToRegExp('.github/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(matchesAnyGlob('AGENTS.md', ['**/AGENTS.md'])).toBe(true);
    expect(matchesAnyGlob('apps/web/AGENTS.md', ['**/AGENTS.md'])).toBe(true);
    expect(matchesAnyGlob('src/.env', ['**/.env'])).toBe(true);
    expect(matchesAnyGlob('.env.example', policy.forbiddenPaths)).toBe(false);
    expect(matchesAnyGlob('src/dist.ts', policy.generatedPaths)).toBe(false);
    expect(matchesAnyGlob('packages/a/dist/index.js', policy.generatedPaths)).toBe(true);
    expect(matchesAnyGlob('a.b', ['a?b'])).toBe(true);
    expect(matchesAnyGlob('a/b', ['a?b', 'a*b'])).toBe(false);
  });
});

describe('diff policy', () => {
  it('accepts a focused planned change', () => {
    const result = evaluate([{ repository: 'web', files: [file('src/app.ts')], addedLines: [{ path: 'src/app.ts', line: 1, text: 'export const x = 1;' }], patchSkipped: false }]);
    expect(result.violations).toEqual([]);
    expect(result.evidence).toEqual([expect.objectContaining({ repository: 'web', changedFiles: 1, addedLines: 1, unplannedFiles: [] })]);
  });

  it('rejects unchanged diffs overall and in required repositories', () => {
    expect(rules(evaluate([{ repository: 'web', files: [], addedLines: [], patchSkipped: false }]))).toEqual(['unchanged', 'unchanged']);
    const partial = evaluate(
      [{ repository: 'web', files: [file('src/a.ts')], addedLines: [], patchSkipped: false }, { repository: 'academic', files: [], addedLines: [], patchSkipped: false }],
      ['web', 'academic'],
    );
    expect(partial.violations).toEqual([expect.objectContaining({ repository: 'academic', rule: 'unchanged' })]);
    expect(evaluate([{ repository: 'web', files: [file('src/a.ts')], addedLines: [], patchSkipped: false }], []).violations).toEqual([]);
  });

  it('rejects unexpectedly broad diffs', () => {
    const files = ['src/a.ts', 'src/b.ts', 'other/c.ts', 'other/d.ts'].map((path) => file(path, { addedLines: 6 }));
    expect(rules(evaluate([{ repository: 'web', files, addedLines: [], patchSkipped: true }]))).toEqual(['too-many-files', 'too-many-lines', 'too-many-unplanned-files']);
  });

  it('rejects protected configuration, generated output, binaries, symlinks, and submodules', () => {
    const files = [
      file('.github/workflows/ci.yml'),
      file('AGENTS.md'),
      file('dist/bundle.js'),
      file('src/logo.png', { status: 'A', addedLines: null, deletedLines: null }),
      file('src/link', { status: 'A', mode: '120000' }),
    ];
    const changes: RepositoryChanges[] = [{ repository: 'web', files, addedLines: [], patchSkipped: false }];
    expect(rules(evaluateChanges({ changes, policy: { ...policy, maxChangedFiles: 10, maxUnplannedFiles: 10 }, required: [], plannedPaths: {}, knownSecrets: [] }))).toEqual([
      'forbidden-path:.github/workflows/ci.yml', 'forbidden-path:AGENTS.md', 'generated-path:dist/bundle.js', 'binary-file:src/logo.png', 'symlink:src/link',
    ]);
    const submodule = evaluateChanges({ changes: [{ repository: 'web', files: [file('vendor/lib', { mode: '160000' })], addedLines: [], patchSkipped: false }], policy, required: [], plannedPaths: {}, knownSecrets: [] });
    expect(rules(submodule)).toEqual(['submodule:vendor/lib']);
    const deletedGenerated = evaluateChanges({ changes: [{ repository: 'web', files: [file('src/dist/old.js', { status: 'D', mode: '000000' })], addedLines: [], patchSkipped: false }], policy, required: [], plannedPaths: { web: ['src'] }, knownSecrets: [] });
    expect(deletedGenerated.violations).toEqual([]);
  });

  it('rejects added secrets without recording their values', () => {
    const addedLines = [
      { path: 'src/config.ts', line: 3, text: 'const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";' },
      { path: 'src/config.ts', line: 4, text: 'const leaked = "s3cr3t-orchestrator-value";' },
      { path: 'src/key.pem', line: 1, text: '-----BEGIN RSA PRIVATE KEY-----' },
    ];
    const result = evaluate([{ repository: 'web', files: [file('src/config.ts'), file('src/key.pem')], addedLines, patchSkipped: false }]);
    expect(result.violations.filter((violation) => violation.rule === 'secret').map((violation) => violation.detail)).toEqual([
      'line 3 matches github-token', 'line 4 matches known-secret', 'line 1 matches private-key',
    ]);
    expect(JSON.stringify(result)).not.toContain('s3cr3t-orchestrator-value');
    expect(JSON.stringify(result)).not.toContain('ghp_abcdefghij');
  });
});

describe('secrets', () => {
  it('collects credential values, including URL passwords, and redacts them', () => {
    const known = collectKnownSecrets({ LINEAR_API_KEY: 'lin_api_value_123456', DATABASE_URL: 'postgres://user:db-password-9@host/db', PATH: '/usr/bin', SHORT_TOKEN: 'abc' });
    expect(known).toEqual(expect.arrayContaining(['lin_api_value_123456', 'postgres://user:db-password-9@host/db', 'db-password-9']));
    expect(known).not.toContain('/usr/bin');
    expect(redactSecrets('failed with db-password-9 and sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', known)).toBe('failed with [REDACTED] and [REDACTED]');
    expect(detectSecrets('AKIAABCDEFGHIJKLMNOP', [])).toEqual(['aws-access-key-id']);
    expect(detectSecrets('const password = "short";', [])).toEqual([]);
  });
});

describe('git diff parsers', () => {
  it('parses raw, numstat, and zero-context patch output', () => {
    expect(parseRawDiff(':100644 100644 aaa bbb M\0src/a.ts\0:000000 120000 000 ccc A\0link\0')).toEqual([
      { path: 'src/a.ts', status: 'M', mode: '100644' },
      { path: 'link', status: 'A', mode: '120000' },
    ]);
    expect(parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0')).toEqual(new Map([
      ['src/a.ts', { added: 3, deleted: 1 }],
      ['img.png', { added: null, deleted: null }],
    ]));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -1,0 +2,2 @@', '+first', '+++ content that looks like a header', '@@ -9 +10 @@', '-old', '+new',
      'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([
      { path: 'src/a.ts', line: 2, text: 'first' },
      { path: 'src/a.ts', line: 3, text: '++ content that looks like a header' },
      { path: 'src/a.ts', line: 10, text: 'new' },
    ]);
  });
});
