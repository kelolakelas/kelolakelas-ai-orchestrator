import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, constants, realpath } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config/config.js';
import { effectiveProviders } from './config/providers.js';
import { createDatabase } from './db/client.js';
import { DispatchingAgentRunner } from './execution/dispatching-runner.js';
import { runBoundedProcess } from './execution/bounded-process.js';
import { DocumentationLoader } from './execution/documentation.js';
import { createProviderRegistry } from './execution/provider-registry.js';
import { QualityGateRunner } from './execution/quality-gates.js';
import { createSandbox, verifySandbox } from './execution/sandbox.js';
import { collectKnownSecrets } from './execution/secrets.js';
import { createExecutionHandlers } from './execution/stages/index.js';
import type { ExecutionDependencies } from './execution/stages/stage-support.js';
import { WorkspaceChanges } from './execution/workspace-changes.js';
import { createHttpServer } from './http/server.js';
import { createLogger } from './observability/logger.js';
import { OrchestratorMetrics } from './observability/orchestrator-metrics.js';
import { RetentionMaintenance } from './operations/retention.js';
import { Scheduler, type MaintenanceTask } from './orchestrator/scheduler.js';
import type { StageHandlers } from './orchestrator/stage-handler.js';
import { CircuitBreaker } from './providers/circuit-breaker.js';
import { GitHubRestProvider } from './providers/github.js';
import { CircuitBreakingGitHubProvider, CircuitBreakingLinearProvider } from './providers/guarded-providers.js';
import { LinearGraphqlProvider } from './providers/linear.js';
import { MetricsRepository } from './repositories/metrics.repository.js';
import { OperatorRepository } from './repositories/operator.repository.js';
import { RetentionRepository } from './repositories/retention.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { auditCredentialExposure } from './security/credential-exposure.js';
import { gitEnvironment, GitRunner } from './workspaces/git.js';
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

  // The pre-registry `agents.runner` block still works, but every provider it serves is now recorded by alias, so an
  // operator migrating to `models.providers` can see exactly which provider each task ran on.
  for (const provider of effectiveProviders(config)) {
    if (provider.legacy) {
      logger.warn({ event: 'legacy_runner_configuration', provider: provider.alias, kind: provider.kind }, `agents.runner is deprecated; declare models.providers.${provider.alias} instead`);
    }
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (config.orchestrator.execution.deliver && !githubToken) throw new Error('GITHUB_TOKEN is required when orchestrator.execution.deliver is true');
  if (config.workspace?.gitAuthentication === 'github-token' && !githubToken) throw new Error('GITHUB_TOKEN is required when workspace.gitAuthentication is github-token');

  // Agents and quality commands run as the service user; delivery refuses to start while they could reach credentials.
  const exposure = await auditCredentialExposure({ config, configPath, environment: process.env, home: homedir() });
  for (const finding of exposure) logger.warn({ event: 'credential_exposure_finding', check: finding.check }, finding.message);
  if (exposure.length > 0 && config.orchestrator.execution.deliver && !config.security.acceptCredentialExposure) {
    throw new Error(`Delivery is enabled but the credential exposure audit reported ${exposure.length} finding(s); fix them or set security.acceptCredentialExposure for a non-production sandbox`);
  }

  const metrics = new OrchestratorMetrics();
  let scheduler: Scheduler | undefined;
  const breaker = (provider: string) => {
    const events = metrics.circuitEvents(provider);
    return new CircuitBreaker(provider, config.providers.circuitBreaker, () => new Date(), {
      ...events,
      onStateChange: (state, openUntil) => {
        events.onStateChange?.(state, openUntil);
        log('provider_circuit_state_changed', { provider, state, openUntil });
        // Delivery stages only talk to GitHub and Linear; claiming them while GitHub is down would only wait again.
        if (provider === 'github' && state === 'open' && openUntil !== null) scheduler?.holdLane('delivery', openUntil, 'github circuit open');
      },
    });
  };
  const linear = new CircuitBreakingLinearProvider(new LinearGraphqlProvider(config.linear, apiKey), breaker('linear'));

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
    const git = new GitRunner(
      config.workspace.gitTimeoutSeconds * 1_000,
      gitEnvironment(process.env, config.workspace.gitAuthentication === 'github-token' ? githubToken : undefined),
    );
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
      const knownSecrets = collectKnownSecrets(process.env);
      const sandbox = createSandbox(config.sandbox);
      await verifySandbox(sandbox, runBoundedProcess);
      const providers = createProviderRegistry(config, {
        // Inside the workspace root but outside every task directory, so no agent can write run files.
        scratchRoot: join(registry.workspaceRoot, '.runner'),
        sourceEnvironment: process.env,
        // A `cli` provider is confined only by this sandbox, which has already passed its startup check.
        sandbox,
        maxResultBytes: agents.runner.maxResultBytes,
        maxEventBytes: agents.runner.maxEventBytes,
        knownSecrets,
      });
      // Fail closed on every provider this configuration routes to, not only the legacy single runner.
      for (const provider of providers.handles) {
        await access(provider.executable, constants.X_OK).catch(() => {
          throw new Error(`Agent runner executable for provider ${provider.alias} (${provider.kind}) is not executable: ${provider.executable}`);
        });
      }
      const execution: ExecutionDependencies = {
        config,
        agents,
        tasks,
        registry,
        workspaces,
        changes: new WorkspaceChanges(git),
        runner: new DispatchingAgentRunner(providers),
        quality: new QualityGateRunner({
          quality: (repository) => {
            const entry = config.repositories[registry.get(repository).name];
            if (entry === undefined) throw new Error(`Repository ${repository} has no configuration`);
            return entry.quality;
          },
          sourceEnvironment: process.env,
          knownSecrets,
          sandbox,
          // Worktree metadata lives in the canonical clone's Git directory; commands may read it but never change it.
          readOnlyPaths: (repository) => [join(registry.get(repository).path, '.git')],
        }),
        documentation: new DocumentationLoader(agents.documentation, config.repositories),
        workerId,
        knownSecrets,
        clock: () => new Date(),
      };
      const delivery = config.orchestrator.execution.deliver && config.delivery !== undefined && githubToken
        ? { delivery: config.delivery, github: new CircuitBreakingGitHubProvider(new GitHubRestProvider(config.delivery.github, githubToken), breaker('github')), linear }
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
      sandbox: config.sandbox.kind,
      gitAuthentication: config.workspace.gitAuthentication,
    });
  }
  maintenance.push(new RetentionMaintenance({
    config: config.retention,
    repository: new RetentionRepository(db),
    ...(config.workspace !== undefined && config.orchestrator.execution.runAgents ? { runnerScratchRoot: join(await realpath(config.workspace.root), '.runner') } : {}),
    log,
    onRemoved: (kind, count) => metrics.retentionRemoved(kind, count),
  }));

  const forceKillSwitch = process.env.ORCHESTRATOR_KILL_SWITCH === 'true';
  scheduler = new Scheduler({
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
    forceKillSwitch,
    observer: metrics,
  });
  const running = scheduler;
  const metricsRepository = new MetricsRepository(db);
  metrics.registry.addCollector('database', async () => metrics.applySnapshot(await metricsRepository.snapshot(), config.metrics.modelPricing));
  metrics.registry.addCollector('scheduler', async () => {
    const status = running.status();
    metrics.applyScheduler({ inFlight: status.inFlight, controls: status.controls, laneHolds: status.laneHolds });
  });
  const server = createHttpServer({
    scheduler: running,
    operator,
    ...(config.orchestrator.http.metrics ? { metrics: metrics.registry } : {}),
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
    const { abandonedTaskIds } = await running.stop();
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
  if (forceKillSwitch) logger.warn({ event: 'kill_switch_forced' }, 'ORCHESTRATOR_KILL_SWITCH is set; no stage or maintenance will run on this worker');
  await running.start();
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Orchestrator failed to start');
  process.exit(1);
});
