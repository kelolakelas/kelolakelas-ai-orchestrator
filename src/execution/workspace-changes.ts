import type { GitRunner } from '../workspaces/git.js';
import type { AddedLine, ChangedFile, RepositoryChanges } from './diff-policy.js';

/** Parses `git diff --raw -z --no-renames` into path, status, and resulting mode. */
export function parseRawDiff(output: string): Array<Pick<ChangedFile, 'path' | 'status' | 'mode'>> {
  const fields = output.split('\0');
  const entries: Array<Pick<ChangedFile, 'path' | 'status' | 'mode'>> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index] as string;
    const path = fields[index + 1] as string;
    if (!header.startsWith(':')) break;
    const [, newMode, , , status] = header.slice(1).split(' ');
    entries.push({ path, status: (status ?? '?').charAt(0), mode: newMode ?? '000000' });
  }
  return entries;
}

/** Parses `git diff --numstat -z --no-renames`; binary files report `-` counts. */
export function parseNumstat(output: string): Map<string, { added: number | null; deleted: number | null }> {
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const record of output.split('\0')) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    counts.set(match[3] as string, {
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return counts;
}

/** Extracts added lines with their new line numbers from a zero-context patch. */
export function parseAddedLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];
  let path: string | null = null;
  let line = 0;
  // File headers precede the first hunk; inside hunks a content line such as "++ x" also starts with "+++ ".
  let inHeader = false;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHeader = true;
      path = null;
    } else if (inHeader && text.startsWith('+++ ')) {
      const target = text.slice(4);
      path = target === '/dev/null' ? null : target.replace(/^"?b\//, '').replace(/"$/, '');
    } else if (text.startsWith('@@')) {
      inHeader = false;
      const match = /\+(\d+)(?:,\d+)? @@/.exec(text);
      line = match ? Number(match[1]) : 0;
    } else if (!inHeader && text.startsWith('+') && path !== null) {
      added.push({ path, line, text: text.slice(1) });
      line += 1;
    }
  }
  return added;
}

/**
 * Reads the working-tree changes of one worktree against its HEAD. Changes are staged first, so untracked files are
 * included and the inspected index is exactly what a following commit records. Ignored files are never included.
 */
export class WorkspaceChanges {
  constructor(private readonly git: GitRunner) {}

  async collect(repository: string, workspacePath: string, maxChangedLines: number): Promise<RepositoryChanges> {
    const cwd = { cwd: workspacePath };
    await this.git.run(['add', '--all'], cwd);
    const raw = parseRawDiff((await this.git.run(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', 'HEAD'], cwd)).stdout);
    const numstat = parseNumstat((await this.git.run(['diff', '--cached', '--numstat', '-z', '--no-renames', '--no-ext-diff', 'HEAD'], cwd)).stdout);
    const files: ChangedFile[] = raw.map((entry) => ({
      ...entry,
      addedLines: numstat.get(entry.path)?.added ?? null,
      deletedLines: numstat.get(entry.path)?.deleted ?? null,
    }));
    const totalLines = files.reduce((total, file) => total + (file.addedLines ?? 0) + (file.deletedLines ?? 0), 0);
    if (files.length === 0 || totalLines > maxChangedLines) {
      return { repository, files, addedLines: [], patchSkipped: files.length > 0 };
    }
    const patch = await this.git.output(['-c', 'core.quotePath=false', 'diff', '--cached', '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD'], cwd);
    return { repository, files, addedLines: parseAddedLines(patch), patchSkipped: false };
  }

  /** HEAD and porcelain status, used to prove that a read-only agent changed nothing. */
  async snapshot(workspacePath: string): Promise<{ head: string; status: string }> {
    const cwd = { cwd: workspacePath };
    return {
      head: await this.git.output(['rev-parse', 'HEAD'], cwd),
      status: await this.git.output(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no'], cwd),
    };
  }

  async isAncestor(workspacePath: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await this.git.run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: workspacePath, allowFailure: true })).exitCode === 0;
  }

  /** Committed task changes since the base commit, truncated for a review prompt. */
  async diffFromBase(workspacePath: string, baseCommit: string, maxBytes: number): Promise<{ stat: string; diff: string; truncated: boolean }> {
    const cwd = { cwd: workspacePath };
    const range = `${baseCommit}..HEAD`;
    const stat = await this.git.output(['diff', '--stat', '--no-color', '--no-ext-diff', range], cwd);
    let diff: string;
    try {
      diff = await this.git.output(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', range], cwd);
    } catch {
      // Larger than the Git output buffer; the stat still describes the change.
      return { stat, diff: '', truncated: true };
    }
    const bytes = Buffer.from(diff, 'utf8');
    return bytes.length > maxBytes
      ? { stat, diff: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
      : { stat, diff, truncated: false };
  }
}
