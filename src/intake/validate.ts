import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validatePlanningBacklog, type PlanningBacklog } from './planning-contract.js';

export async function loadPlanningBacklog(path: string): Promise<PlanningBacklog> {
  const content = await readFile(resolve(path), 'utf8');
  return validatePlanningBacklog(parse(content));
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    throw new Error('Usage: npm run intake:validate -- <planning-backlog.yaml|json>');
  }

  const backlog = await loadPlanningBacklog(path);
  console.log(JSON.stringify({
    event: 'planning_backlog_validated',
    schemaVersion: backlog.schemaVersion,
    projects: backlog.projects.length,
    issues: backlog.issues.length,
  }));
}

if (process.argv[1]?.endsWith('/src/intake/validate.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}