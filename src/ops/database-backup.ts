import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';

/** Tables whose row counts are recorded in a backup manifest and compared after a restore. */
export const orchestratorTables = [
  'tasks', 'state_transitions', 'task_dependencies', 'task_work_units', 'task_attempts', 'task_checkpoints',
  'external_operations', 'intake_quarantines', 'orchestrator_controls', 'operator_actions',
] as const;

export interface BackupManifest {
  format: 'kelolakelas-ai-orchestrator-backup/v1';
  file: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  serverVersion: string;
  latestMigrationCreatedAt: string | null;
  migrations: number;
  rowCounts: Record<string, number>;
}

export interface PostgresTools {
  pgDump: string;
  pgRestore: string;
  psql: string;
}

export const defaultTools: PostgresTools = {
  pgDump: process.env.PG_DUMP ?? 'pg_dump',
  pgRestore: process.env.PG_RESTORE ?? 'pg_restore',
  psql: process.env.PSQL ?? 'psql',
};

/**
 * libpq variables for a connection URL. Tools receive credentials through the environment, never as arguments, which
 * other processes of the same user could read.
 */
export function libpqEnvironment(connectionUrl: string): NodeJS.ProcessEnv {
  const url = new URL(connectionUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('Database URL must use postgres://');
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGCONNECT_TIMEOUT: '10',
  };
  const host = url.searchParams.get('host') ?? url.hostname;
  if (host) environment.PGHOST = decodeURIComponent(host);
  if (url.port) environment.PGPORT = url.port;
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) environment.PGSSLMODE = sslmode;
  return environment;
}

function run(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(executable)} exited with ${code}: ${stderr.trim()}`))));
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function inspectDatabase(connectionUrl: string): Promise<Pick<BackupManifest, 'serverVersion' | 'latestMigrationCreatedAt' | 'migrations' | 'rowCounts'>> {
  const client = new pg.Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    const version = await client.query<{ server_version: string }>('show server_version');
    const migrations = await client.query<{ total: string; latest: string | null }>(
      "select count(*)::text as total, max(created_at)::text as latest from drizzle.__drizzle_migrations",
    ).catch(() => ({ rows: [{ total: '0', latest: null }] }));
    const rowCounts: Record<string, number> = {};
    for (const table of orchestratorTables) {
      const result = await client.query<{ total: string }>(`select count(*)::text as total from public.${table}`).catch(() => undefined);
      if (result !== undefined) rowCounts[table] = Number(result.rows[0]?.total ?? 0);
    }
    return {
      serverVersion: version.rows[0]?.server_version ?? 'unknown',
      latestMigrationCreatedAt: migrations.rows[0]?.latest ?? null,
      migrations: Number(migrations.rows[0]?.total ?? 0),
      rowCounts,
    };
  } finally {
    await client.end();
  }
}

/**
 * Writes a PostgreSQL custom-format dump with a checksum manifest, then removes dumps older than `keepDays`. Row counts
 * are read before the dump starts, so a busy database may hold slightly more rows in the dump than in the manifest.
 */
export async function backupDatabase(input: { databaseUrl: string; directory: string; keepDays?: number; tools?: PostgresTools; now?: Date }): Promise<BackupManifest> {
  const tools = input.tools ?? defaultTools;
  const now = input.now ?? new Date();
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const name = `ai-orchestrator-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump`;
  const path = join(input.directory, name);
  const partial = `${path}.partial`;

  const inspected = await inspectDatabase(input.databaseUrl);
  await run(tools.pgDump, ['--format=custom', '--no-owner', '--no-privileges', `--file=${partial}`], libpqEnvironment(input.databaseUrl));
  await chmod(partial, 0o600);
  await rename(partial, path);

  const manifest: BackupManifest = {
    format: 'kelolakelas-ai-orchestrator-backup/v1',
    file: name,
    sha256: await sha256File(path),
    bytes: (await stat(path)).size,
    createdAt: now.toISOString(),
    ...inspected,
  };
  await writeFile(`${path}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  if (input.keepDays !== undefined) await pruneBackups(input.directory, input.keepDays, now);
  return manifest;
}

async function pruneBackups(directory: string, keepDays: number, now: Date): Promise<void> {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1_000;
  for (const name of await readdir(directory)) {
    if (!/^ai-orchestrator-\d{8}T\d{6}Z\.dump(?:\.json)?$/.test(name)) continue;
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
  }
}

/**
 * Restores a verified dump into an empty database. The dump is rendered as SQL and applied in one transaction with
 * `ON_ERROR_STOP`, so a failed restore leaves the target empty. `SET transaction_timeout` is dropped because newer
 * `pg_restore` versions emit it and PostgreSQL 16 rejects it.
 */
export async function restoreDatabase(input: { dumpPath: string; targetDatabaseUrl: string; tools?: PostgresTools }): Promise<{ manifest: BackupManifest; restored: Awaited<ReturnType<typeof inspectDatabase>> }> {
  const tools = input.tools ?? defaultTools;
  const manifest = JSON.parse(await readFile(`${input.dumpPath}.json`, 'utf8')) as BackupManifest;
  if (manifest.format !== 'kelolakelas-ai-orchestrator-backup/v1') throw new Error('Unknown backup manifest format');
  const actual = await sha256File(input.dumpPath);
  if (actual !== manifest.sha256) throw new Error(`Backup checksum mismatch: expected ${manifest.sha256}, found ${actual}`);

  const target = new pg.Client({ connectionString: input.targetDatabaseUrl });
  await target.connect();
  try {
    const existing = await target.query<{ total: string }>("select count(*)::text as total from information_schema.tables where table_schema in ('public', 'drizzle')");
    if (Number(existing.rows[0]?.total ?? 0) > 0) throw new Error('Target database is not empty; restore only into a new, empty database');
  } finally {
    await target.end();
  }

  const environment = libpqEnvironment(input.targetDatabaseUrl);
  await new Promise<void>((resolve, reject) => {
    const render = spawn(tools.pgRestore, ['--no-owner', '--no-privileges', '--file=-', input.dumpPath], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const apply = spawn(tools.psql, ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1', '--output=/dev/null'], { env: environment, stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    const collect = (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-4_000); };
    render.stderr.on('data', collect);
    apply.stderr.on('data', collect);
    const lines = createInterface({ input: render.stdout });
    lines.on('line', (line) => {
      if (!/^SET transaction_timeout\b/.test(line)) apply.stdin.write(`${line}\n`);
    });
    lines.on('close', () => apply.stdin.end());
    apply.stdin.on('error', () => undefined);
    let renderCode: number | null = null;
    render.on('error', reject);
    apply.on('error', reject);
    render.on('close', (code) => { renderCode = code; });
    apply.on('close', (code) => {
      if (code === 0 && renderCode === 0) resolve();
      else reject(new Error(`Restore failed (pg_restore ${renderCode}, psql ${code}): ${errors.trim()}`));
    });
  });

  const restored = await inspectDatabase(input.targetDatabaseUrl);
  for (const [table, rows] of Object.entries(manifest.rowCounts)) {
    if ((restored.rowCounts[table] ?? -1) < rows) throw new Error(`Restored ${table} has ${restored.rowCounts[table] ?? 0} rows; the backup manifest recorded ${rows}`);
  }
  if (restored.migrations !== manifest.migrations) throw new Error(`Restored database has ${restored.migrations} migrations; the backup had ${manifest.migrations}`);
  return { manifest, restored };
}
