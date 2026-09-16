import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrchestratorConfig } from '../config/schema.js';

export interface ExposureFinding {
  check: 'config-writable' | 'sandbox-disabled' | 'git-host-credentials' | 'credential-file-readable' | 'database-passwordless';
  message: string;
}

export interface CredentialExposureInput {
  config: OrchestratorConfig;
  configPath: string;
  environment: NodeJS.ProcessEnv;
  home: string;
}

/** Public or non-secret files that commonly sit beside credentials. */
const publicFileName = /(?:\.pub|^known_hosts(?:\.old)?|^config|^authorized_keys)$/;

async function readable(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(() => true, () => false);
}

/** A regular file is exposed when this process can read it; a directory when any private file directly inside it is. */
async function exposedPaths(path: string): Promise<string[]> {
  const entry = await stat(path).catch(() => undefined);
  if (entry === undefined) return [];
  if (entry.isFile()) return await readable(path) ? [path] : [];
  if (!entry.isDirectory()) return [];
  const names = await readdir(path).catch(() => [] as string[]);
  const exposed: string[] = [];
  for (const name of names.filter((candidate) => !publicFileName.test(candidate))) {
    const child = join(path, name);
    if ((await stat(child).catch(() => undefined))?.isFile() && await readable(child)) exposed.push(child);
  }
  return exposed;
}

/**
 * Checks, at startup, whether processes started for agents and quality commands could obtain orchestrator credentials.
 * Those processes run as the service user, so anything that user can read or write is in scope. The audit cannot see
 * PostgreSQL `pg_hba.conf` or remote token scopes; the credential runbook covers those.
 */
export async function auditCredentialExposure(input: CredentialExposureInput): Promise<ExposureFinding[]> {
  const { config, environment } = input;
  const findings: ExposureFinding[] = [];

  // The configuration defines the commands the orchestrator executes, so it must not be writable by other accounts.
  for (const path of [input.configPath, dirname(input.configPath)]) {
    const mode = (await stat(path).catch(() => undefined))?.mode;
    if (mode !== undefined && (mode & 0o022) !== 0) {
      findings.push({ check: 'config-writable', message: `${path} is writable by group or others` });
    }
  }

  if (!config.orchestrator.execution.runAgents) return findings;

  if (config.sandbox.kind === 'none') {
    findings.push({ check: 'sandbox-disabled', message: 'Quality commands run agent-written code without a sandbox and can read orchestrator process environments' });
  }
  if (config.workspace?.gitAuthentication !== 'github-token') {
    findings.push({ check: 'git-host-credentials', message: 'Git uses host credential helpers or SSH keys, which agent processes can read; set workspace.gitAuthentication to github-token' });
  }
  for (const configured of config.security.credentialFiles) {
    const path = configured.startsWith('~/') ? join(input.home, configured.slice(2)) : configured;
    for (const exposed of await exposedPaths(path)) {
      findings.push({ check: 'credential-file-readable', message: `${exposed} is readable by the service user` });
    }
  }
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl !== undefined) {
    let password = '';
    try {
      password = new URL(databaseUrl).password;
    } catch {
      // A keyword/value connection string; the password check below still applies.
    }
    if (password === '' && environment.PGPASSWORD === undefined) {
      findings.push({ check: 'database-passwordless', message: 'DATABASE_URL has no password; peer or trust authentication lets any process of the service user connect to PostgreSQL' });
    }
  }
  return findings;
}
