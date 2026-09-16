import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { loadConfig } from './config/config.js';
import { createDatabase } from './db/client.js';
import { createHttpServer } from './http/server.js';
import { createLogger } from './observability/logger.js';
import { Scheduler, type MaintenanceTask } from './orchestrator/scheduler.js';
import type { StageHandlers } from './orchestrator/stage-handler.js';
import { LinearGraphqlProvider } from './providers/linear.js';
import { OperatorRepository } from './repositories/operator.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { GitRunner } from './workspaces/git.js';
import { WorkspacePreparationStage } from './workspaces/preparation-stage.js';
import { PostgresRepositoryLock } from './workspaces/repository-lock.js';
import { RepositoryRegistry } from './workspaces/repository-registry.js';
import { WorkspaceJanitor } from './workspaces/workspace-janitor.js';
import { WorkspaceManager } from './workspaces/workspace-manager.js';

const configPath = process.env.ORCHESTRATOR_CONFIG ?? './orchestrator.config.example.yaml';
const logger = createLogger();

async function main(): Promise<void> {
  const config = await loadConfig(configPath);
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error('LINEAR_API_KEY is required for Linear intake');
  const dryRun = process.env.ORCHESTRATOR_DRY_RUN === 'true';
  const configuredWorkerId = process.env.ORCHESTRATOR_WORKER_ID;
  const workerId = configuredWorkerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const log = (event: string, fields: Record<string, unknown> = {}) => logger.info({ ...fields, event }, event);

  const { db, pool } = createDatabase();
  pool.on('error', (error) => logger.error({ err: { name: error.name } }, 'PostgreSQL idle client error'));
  const tasks = new TaskRepository(db);
  const operator = new OperatorRepository(db);

  // Stage handlers are opt-in. Phase 4 prepares worktrees; analysis and implementation arrive in Phase 5. Workspace
  // releases run whenever a registry is configured so terminal tasks never leave worktrees behind.
  const handlers: StageHandlers = {};
  const maintenance: MaintenanceTask[] = [];
  if (config.workspace !== undefined) {
    const registry = await RepositoryRegistry.load(config);
    const workspaces = new WorkspaceManager(
      registry,
      new GitRunner(config.workspace.gitTimeoutSeconds * 1_000),
      new PostgresRepositoryLock(pool, config.workspace.repositoryLockTimeoutSeconds * 1_000),
      { minimumFreeDiskMb: config.workspace.minimumFreeDiskMb },
    );
    maintenance.push(new WorkspaceJanitor(workspaces, tasks, log));
    if (config.orchestrator.execution.prepareWorkspaces) {
      handlers.ANALYZING = new WorkspacePreparationStage(workspaces, tasks, { workerId, remoteRetryMs: config.workspace.remoteRetryMinutes * 60_000 });
    }
    log('workspace_registry_loaded', { root: registry.workspaceRoot, repositories: registry.names(), prepareWorkspaces: config.orchestrator.execution.prepareWorkspaces });
  }
  const scheduler = new Scheduler({
    config,
    linear: new LinearGraphqlProvider(config.linear, apiKey),
    tasks,
    operator,
    workerId,
    dryRun,
    log,
    handlers,
    maintenance,
    recoverOwnLeasesOnStart: configuredWorkerId !== undefined,
  });
  const server = createHttpServer({
    scheduler,
    operator,
    pingDatabase: () => tasks.ping(),
    operatorToken: process.env.ORCHESTRATOR_OPERATOR_TOKEN,
    dryRun,
    log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Forced termination; held leases will expire and be recovered for manual intervention');
      process.exit(1);
    }
    shuttingDown = true;
    log('shutdown_started', { signal, workerId });
    const { abandonedTaskIds } = await scheduler.stop();
    server.close();
    await pool.end();
    log('shutdown_completed', { workerId, abandonedTaskIds });
    process.exitCode = abandonedTaskIds.length > 0 ? 1 : 0;
  };
  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));

  server.listen(config.orchestrator.http.port, config.orchestrator.http.host);
  await once(server, 'listening');
  log('orchestrator_started', {
    workerId,
    dryRun,
    http: `${config.orchestrator.http.host}:${config.orchestrator.http.port}`,
    operatorApi: process.env.ORCHESTRATOR_OPERATOR_TOKEN ? 'enabled' : 'disabled',
  });
  await scheduler.start();
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Orchestrator failed to start');
  process.exit(1);
});
