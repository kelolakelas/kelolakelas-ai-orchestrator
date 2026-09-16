import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, constants } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config/config.js';
import { createDatabase } from './db/client.js';
import { CodexCliRunner } from './execution/agent-runner.js';
import { DocumentationLoader } from './execution/documentation.js';
import { QualityGateRunner } from './execution/quality-gates.js';
import { collectKnownSecrets } from './execution/secrets.js';
import { createExecutionHandlers } from './execution/stages/index.js';
import type { ExecutionDependencies } from './execution/stages/stage-support.js';
import { WorkspaceChanges } from './execution/workspace-changes.js';
import { createHttpServer } from './http/server.js';
import { createLogger } from './observability/logger.js';
import { Scheduler, type MaintenanceTask } from './orchestrator/scheduler.js';
import type { StageHandlers } from './orchestrator/stage-handler.js';
import { GitHubRestProvider } from './providers/github.js';
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

  const githubToken = process.env.GITHUB_TOKEN;
  if (config.orchestrator.execution.deliver && !githubToken) throw new Error('GITHUB_TOKEN is required when orchestrator.execution.deliver is true');
  const linear = new LinearGraphqlProvider(config.linear, apiKey);

  const { db, pool } = createDatabase();
  pool.on('error', (error) => logger.error({ err: { name: error.name } }, 'PostgreSQL idle client error'));
  const tasks = new TaskRepository(db);
  const operator = new OperatorRepository(db);

  // Stage handlers are opt-in. Phase 4 prepares worktrees; Phase 5 adds analysis, implementation, quality gates, fixes,
  // and review; Phase 6 pushes reviewed branches, opens pull requests, and observes checks, reviews, and merges. Without
  // delivery, reviewed local branches park in BLOCKED. Workspace releases run whenever a registry is configured so
  // terminal tasks never leave worktrees behind.
  const handlers: StageHandlers = {};
  const maintenance: MaintenanceTask[] = [];
  if (config.workspace !== undefined) {
    const registry = await RepositoryRegistry.load(config);
    const git = new GitRunner(config.workspace.gitTimeoutSeconds * 1_000);
    const workspaces = new WorkspaceManager(
      registry,
      git,
      new PostgresRepositoryLock(pool, config.workspace.repositoryLockTimeoutSeconds * 1_000),
      { minimumFreeDiskMb: config.workspace.minimumFreeDiskMb },
    );
    maintenance.push(new WorkspaceJanitor(workspaces, tasks, log));
    const preparation = { workerId, remoteRetryMs: config.workspace.remoteRetryMinutes * 60_000 };
    if (config.orchestrator.execution.runAgents && config.agents !== undefined) {
      const agents = config.agents;
      await access(agents.runner.executable, constants.X_OK).catch(() => {
        throw new Error(`Agent runner executable is not executable: ${agents.runner.executable}`);
      });
      const knownSecrets = collectKnownSecrets(process.env);
      const execution: ExecutionDependencies = {
        config,
        agents,
        tasks,
        registry,
        workspaces,
        changes: new WorkspaceChanges(git),
        runner: new CodexCliRunner({
          executable: agents.runner.executable,
          // Inside the workspace root but outside every task directory, so no agent can write run files.
          scratchRoot: join(registry.workspaceRoot, '.runner'),
          sourceEnvironment: process.env,
          extraEnvironment: agents.runner.environment,
          maxResultBytes: agents.runner.maxResultBytes,
          maxEventBytes: agents.runner.maxEventBytes,
          knownSecrets,
        }),
        quality: new QualityGateRunner({
          quality: (repository) => {
            const entry = config.repositories[registry.get(repository).name];
            if (entry === undefined) throw new Error(`Repository ${repository} has no configuration`);
            return entry.quality;
          },
          sourceEnvironment: process.env,
          knownSecrets,
        }),
        documentation: new DocumentationLoader(agents.documentation, config.repositories),
        workerId,
        knownSecrets,
        clock: () => new Date(),
      };
      const delivery = config.orchestrator.execution.deliver && config.delivery !== undefined && githubToken
        ? { delivery: config.delivery, github: new GitHubRestProvider(config.delivery.github, githubToken), linear }
        : undefined;
      Object.assign(handlers, createExecutionHandlers(execution, preparation, delivery));
    } else if (config.orchestrator.execution.prepareWorkspaces) {
      handlers.ANALYZING = new WorkspacePreparationStage(workspaces, tasks, preparation);
    }
    log('workspace_registry_loaded', {
      root: registry.workspaceRoot,
      repositories: registry.names(),
      prepareWorkspaces: config.orchestrator.execution.prepareWorkspaces,
      runAgents: config.orchestrator.execution.runAgents,
      deliver: config.orchestrator.execution.deliver,
    });
  }
  const scheduler = new Scheduler({
    config,
    linear,
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
