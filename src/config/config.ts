import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validateConfig, type OrchestratorConfig } from './schema.js';

export async function loadConfig(path: string): Promise<OrchestratorConfig> {
  const content = await readFile(resolve(path), 'utf8');
  return validateConfig(parse(content));
}
