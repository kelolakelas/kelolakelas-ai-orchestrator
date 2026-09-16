import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentsConfig, OrchestratorConfig } from '../config/schema.js';
import { isInside } from '../workspaces/repository-registry.js';

export interface DocumentationExcerpt {
  path: string;
  sha256: string;
  content: string;
  truncated: boolean;
}

/**
 * Loads operator-approved documentation for a prompt. Only files listed in configuration are read, each must resolve
 * inside the documentation root, and the total size is bounded. Agents receive this content rather than a path, so
 * the approved set is exactly what the prompt contains.
 */
export class DocumentationLoader {
  constructor(
    private readonly documentation: AgentsConfig['documentation'],
    private readonly repositories: OrchestratorConfig['repositories'],
  ) {}

  async load(repositories: readonly string[]): Promise<DocumentationExcerpt[]> {
    if (this.documentation === undefined) return [];
    const root = await realpath(this.documentation.root);
    const files = [...new Set([
      ...this.documentation.files,
      ...repositories.flatMap((name) => this.repositories[name as keyof OrchestratorConfig['repositories']]?.quality.documentation ?? []),
    ])];
    let remaining = this.documentation.maxBytes;
    const excerpts: DocumentationExcerpt[] = [];
    for (const file of files) {
      const path = await realpath(join(root, file)).catch(() => undefined);
      if (path === undefined || !isInside(root, path)) throw new Error(`Approved documentation ${file} does not resolve inside ${this.documentation.root}`);
      const bytes = await readFile(path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const truncated = bytes.length > remaining;
      excerpts.push({ path: file, sha256, content: bytes.subarray(0, Math.max(0, remaining)).toString('utf8'), truncated });
      remaining = Math.max(0, remaining - bytes.length);
    }
    return excerpts;
  }
}
