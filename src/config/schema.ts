import { isAbsolute } from 'node:path';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { repositoryNames } from '../intake/planning-contract.js';
import { routedModelTiers } from '../routing/escalation-policy.js';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const windowSchema = z.object({
  start: z.string().regex(timePattern, 'must use HH:mm format'),
  end: z.string().regex(timePattern, 'must use HH:mm format'),
});
const daySchema = z.object({ enabled: z.boolean(), windows: z.array(windowSchema) });
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value), 'must be an absolute path');
const gitRefComponent = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'must be a simple Git ref name');

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');
const relativeFilePath = z.string().min(1).refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'must be a relative path without ..');

/** Orchestrator credentials that must never reach an agent or a repository command. */
export const withheldEnvironment = ['DATABASE_URL', 'LINEAR_API_KEY', 'ORCHESTRATOR_OPERATOR_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * A trusted repository command. Commands are argument arrays from operator configuration and are addressed by name;
 * nothing sourced from Linear, repository content, or model output can add or alter one.
 */
const qualityCommandSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase command name'),
  command: z.array(z.string().min(1)).min(1),
  timeoutSeconds: z.number().int().positive().max(7_200).default(900),
  /**
   * Network access inside the command sandbox. Unset means setup commands (dependency installs) have network access and
   * checks do not. Ignored when `sandbox.kind` is `none`.
   */
  network: z.boolean().optional(),
}).strict();

const uniqueCommands = z.array(qualityCommandSchema).superRefine((commands, context) => {
  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'command names must be unique' });
});

const repositorySchema = z.object({
  path: absolutePath,
  github: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name'),
  remote: z.string().regex(/^[A-Za-z0-9._-]+$/, 'must be a Git remote name').default('origin'),
  baseBranch: gitRefComponent.default('main'),
  /** Leased execution-lane tasks that may touch this repository at once, across all workers. Unset means no limit. */
  maxConcurrentTasks: z.number().int().positive().optional(),
  quality: z.object({
    /** Runs before implementation and before every quality pass, for example a dependency install. */
    setup: uniqueCommands.default([]),
    /** Formatter check, lint, typecheck/build, and tests, in order. */
    checks: uniqueCommands.default([]),
    /** Extra environment variable names passed to setup and check commands. */
    environment: z.array(environmentName).default([]),
    /** Documentation files, relative to `agents.documentation.root`, given to agents working in this repository. */
    documentation: z.array(relativeFilePath).default([]),
  }).strict().default({}),
}).strict();

const timeoutMinutes = z.number().int().positive().max(480);

const agentsSchema = z.object({
  runner: z.object({
    kind: z.literal('codex-cli').default('codex-cli'),
    /** Absolute path of the runner executable; it is never resolved through PATH. */
    executable: absolutePath,
    /** Extra environment variable names passed to the runner process, such as `CODEX_HOME` or `OPENAI_API_KEY`. */
    environment: z.array(environmentName).default([]),
    timeoutMinutes: z.object({
      analysis: timeoutMinutes.default(20),
      implementation: timeoutMinutes.default(60),
      fix: timeoutMinutes.default(45),
      review: timeoutMinutes.default(20),
    }).strict().default({}),
    /** Largest accepted final structured result. */
    maxResultBytes: z.number().int().positive().max(4 * 1024 * 1024).default(256 * 1024),
    /** Largest runner event stream; the run is stopped when it is exceeded. */
    maxEventBytes: z.number().int().positive().max(512 * 1024 * 1024).default(64 * 1024 * 1024),
    rateLimitRetryMinutes: z.number().int().positive().default(5),
  }).strict(),
  commitAuthor: z.object({ name: z.string().trim().min(1), email: z.string().email() }).strict(),
  documentation: z.object({
    root: absolutePath,
    /** Files given to every agent, relative to `root`. */
    files: z.array(relativeFilePath).default([]),
    maxBytes: z.number().int().positive().max(2 * 1024 * 1024).default(200_000),
  }).strict().optional(),
  diffPolicy: z.object({
    maxChangedFiles: z.number().int().positive().default(50),
    maxChangedLines: z.number().int().positive().default(2_000),
    /** Changed files that the accepted analysis plan did not name. */
    maxUnplannedFiles: z.number().int().nonnegative().default(10),
    forbiddenPaths: z.array(z.string().min(1)).default([
      '.git/**', '.github/**', '.gitmodules', '**/CODEOWNERS', '.husky/**', '**/.npmrc',
      '**/AGENTS.md', '**/CLAUDE.md', '.codex/**', '.claude/**',
      '**/.env', '**/.env.local', '**/.env.*.local', '**/.env.production', '**/*.pem', '**/*.key', '**/id_rsa*',
    ]),
    generatedPaths: z.array(z.string().min(1)).default([
      '**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.next/**', '**/*.min.js', '**/*.min.css',
    ]),
    allowedBinaryPaths: z.array(z.string().min(1)).default([]),
  }).strict().default({}),
  /** Largest per-repository diff included in a review prompt. */
  maxReviewDiffBytes: z.number().int().positive().max(2 * 1024 * 1024).default(200_000),
}).strict();

const deliverySchema = z.object({
  github: z.object({
    apiUrl: z.string().url().default('https://api.github.com'),
    requestTimeoutMs: z.number().int().positive().max(60_000).default(15_000),
    /** Retries of idempotent reads after a transient failure. Writes are never retried blindly; they are reconciled. */
    maxRetries: z.number().int().nonnegative().max(5).default(3),
  }).strict().default({}),
  /** Delay between observations of pending checks, reviews, and merges. */
  pollIntervalSeconds: z.number().int().min(10).max(3_600).default(120),
  /** Delay before retrying after a transient GitHub, Git remote, or Linear failure without a provider hint. */
  retryIntervalSeconds: z.number().int().min(10).max(3_600).default(300),
  /**
   * How long a required check may stay missing or pending after the pull request head was first observed. Past this,
   * the task blocks for manual intervention instead of waiting forever for a check that never runs.
   */
  requiredChecksTimeoutMinutes: z.number().int().positive().max(10_080).default(180),
  draftPullRequests: z.boolean().default(false),
  /** Posts idempotent Linear comments for delivery milestones. Pull request attachments are always synchronized. */
  linearComments: z.boolean().default(true),
}).strict();

/**
 * Confinement of repository setup and check commands, which execute agent-written code. `bubblewrap` runs each command
 * in new user, PID, IPC, UTS, and cgroup namespaces with a fresh `/proc`, so orchestrator processes and their
 * environments are invisible. Only the listed host paths are mounted, the worktree is the only writable repository
 * path, and there is no home directory.
 */
const sandboxSchema = z.object({
  kind: z.enum(['none', 'bubblewrap']).default('none'),
  /** Absolute path of `bwrap`; it is never resolved through PATH. */
  executable: absolutePath.default('/usr/bin/bwrap'),
  /** Host paths mounted read-only at the same location when they exist. `/bin`, `/lib`, and similar are mirrored. */
  readOnlyPaths: z.array(absolutePath).default(['/usr', '/etc', '/opt', '/run/systemd/resolve']),
  /** Host paths writable by every sandboxed command, such as a dedicated package cache. Never a credential location. */
  writablePaths: z.array(absolutePath).default([]),
  /** Paths replaced by an empty directory even when a parent is mounted, such as the orchestrator's configuration. */
  maskedPaths: z.array(absolutePath).default(['/etc/ai-orchestrator']),
}).strict();

const securitySchema = z.object({
  /**
   * Files that must not be readable by the service user when agents run, because agent and command processes run as
   * that user. `~/` expands to the service user's home. A directory is exposed when any private file in it is readable.
   */
  credentialFiles: z.array(z.string().min(1)).default([
    '~/.git-credentials', '~/.netrc', '~/.config/gh/hosts.yml', '~/.ssh', '~/.docker/config.json', '~/.npmrc',
    '/etc/ai-orchestrator/orchestrator.env',
  ]),
  /**
   * Starts delivery even when the startup credential-exposure audit reports findings. Findings are still logged. Use only
   * for a non-production sandbox.
   */
  acceptCredentialExposure: z.boolean().default(false),
}).strict();

const circuitBreakerSchema = z.object({
  /** Consecutive transient failures or rate limits that open the circuit. */
  failureThreshold: z.number().int().positive().max(100).default(5),
  /** How long an open circuit rejects calls before one probe is allowed. */
  openSeconds: z.number().int().positive().max(3_600).default(300),
}).strict();

const retentionSchema = z.object({
  enabled: z.boolean().default(true),
  /** Attempt evidence and checkpoint payloads of `COMPLETED` and `CANCELLED` tasks are removed after this many days. */
  terminalTaskArtifactDays: z.number().int().positive().default(90),
  /** Quarantine records not seen by intake for this many days are removed; intake re-creates them if still present. */
  quarantineDays: z.number().int().positive().default(30),
  /** Leftover runner scratch directories older than this are removed. Must exceed the longest runner timeout. */
  runnerScratchHours: z.number().int().positive().default(24),
  intervalMinutes: z.number().int().positive().default(60),
}).strict();

const modelPriceSchema = z.object({
  inputPerMillionTokens: z.number().nonnegative(),
  cachedInputPerMillionTokens: z.number().nonnegative().default(0),
  outputPerMillionTokens: z.number().nonnegative(),
}).strict();

export const configSchema = z.object({
  timezone: z.string().min(1),
  orchestrator: z.object({
    maxConcurrentTasks: z.number().int().positive().default(1),
    /** Tasks in delivery states (`PR_CREATED`, `WAITING_CI`, `READY_FOR_HUMAN_REVIEW`) claimed at once, counted separately. */
    maxConcurrentDeliveryTasks: z.number().int().positive().default(2),
    pollingIntervalSeconds: z.number().int().positive().default(60),
    leaseDurationSeconds: z.number().int().min(30).default(300),
    heartbeatIntervalSeconds: z.number().int().positive().default(60),
    shutdownGracePeriodSeconds: z.number().int().positive().max(300).default(30),
    usageLimitPauseMinutes: z.number().int().positive().default(30),
    http: z.object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(0).max(65_535).default(8089),
      /** Serves Prometheus metrics at `/metrics`. Metrics carry no task, issue, or credential identifiers. */
      metrics: z.boolean().default(true),
    }).default({}),
    /**
     * Canary controls for starting new tasks. Tasks already started are unaffected, so narrowing the rollout never strands
     * in-progress work.
     */
    rollout: z.object({
      /** Only tasks whose every repository is listed may start. Unset allows every registered repository. */
      repositories: z.array(z.enum(repositoryNames)).min(1).optional(),
      /** New task starts (`QUEUED -> ANALYZING`) allowed across all workers in any rolling 24 hours. */
      maxNewTasksPerDay: z.number().int().nonnegative().optional(),
    }).strict().default({}),
    execution: z.object({
      /** Registers the Phase 4 workspace preparation stage. Requires `workspace` and `repositories`. */
      prepareWorkspaces: z.boolean().default(false),
      /**
       * Registers the Phase 5 analysis, implementation, quality-gate, fix, and review stages. Requires
       * `prepareWorkspaces`, `agents`, and quality checks for every registered repository. Never pushes.
       */
      runAgents: z.boolean().default(false),
      /**
       * Registers the Phase 6 delivery stages: push reviewed branches, open one pull request per repository, observe
       * required checks, reviews, and merges, and synchronize Linear. Requires `runAgents`, `delivery`, and `GITHUB_TOKEN`.
       * Never merges and never changes a Linear issue status.
       */
      deliver: z.boolean().default(false),
    }).default({}),
  }).default({}),
  workspace: z.object({
    root: absolutePath,
    minimumFreeDiskMb: z.number().int().nonnegative().default(2_048),
    gitTimeoutSeconds: z.number().int().positive().max(3_600).default(300),
    repositoryLockTimeoutSeconds: z.number().int().positive().max(3_600).default(600),
    remoteRetryMinutes: z.number().int().positive().default(5),
    /**
     * `host` uses the service user's Git credential helpers or SSH keys, which agent processes can read. `github-token`
     * authenticates HTTPS fetches and pushes with `GITHUB_TOKEN` passed only through Git's environment, so the service
     * user needs no credential files.
     */
    gitAuthentication: z.enum(['host', 'github-token']).default('host'),
  }).strict().optional(),
  repositories: z.record(z.enum(repositoryNames), repositorySchema).default({}),
  agents: agentsSchema.optional(),
  delivery: deliverySchema.optional(),
  sandbox: sandboxSchema.default({}),
  security: securitySchema.default({}),
  providers: z.object({
    circuitBreaker: circuitBreakerSchema.default({}),
  }).strict().default({}),
  retention: retentionSchema.default({}),
  metrics: z.object({
    /** Prices by model identifier, used to export estimated spend. Models without a price export tokens only. */
    modelPricing: z.record(modelPriceSchema).default({}),
  }).strict().default({}),
  schedule: z.object({
    enabled: z.boolean().default(true),
    allowMechanicalOperationsOutsideHours: z.boolean().default(true),
    finishCurrentStep: z.boolean().default(true),
    startNewStepIfRemainingMinutesAtLeast: z.number().nonnegative().default(20),
    minimumRemainingMinutesForNewTask: z.number().nonnegative().default(45),
    minimumRemainingMinutesForAnalysis: z.number().nonnegative().default(20),
    minimumRemainingMinutesForImplementation: z.number().nonnegative().default(45),
    minimumRemainingMinutesForReview: z.number().nonnegative().default(20),
    days: z.object({
      monday: daySchema.default({ enabled: false, windows: [] }),
      tuesday: daySchema.default({ enabled: false, windows: [] }),
      wednesday: daySchema.default({ enabled: false, windows: [] }),
      thursday: daySchema.default({ enabled: false, windows: [] }),
      friday: daySchema.default({ enabled: false, windows: [] }),
      saturday: daySchema.default({ enabled: false, windows: [] }),
      sunday: daySchema.default({ enabled: false, windows: [] }),
    }),
  }),
  linear: z.object({
    teamKey: z.string().min(1),
    requiredLabels: z.array(z.string()).default([]),
    excludedLabels: z.array(z.string()).default([]),
    apiUrl: z.string().url().default('https://api.linear.app/graphql'),
    requestTimeoutMs: z.number().int().positive().max(60_000).default(10_000),
    maxRetries: z.number().int().nonnegative().max(5).default(3),
  }),
  models: z.object({
    tiers: z.record(z.object({ model: z.string().min(1) })),
    analyzer: z.object({ tier: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'max']) }),
    reviewer: z.object({ tier: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'max']) }),
  }),
  limits: z.object({
    maxImplementationAttempts: z.number().int().positive().default(4),
    maxQualityFixAttempts: z.number().int().positive().default(3),
    maxReviewCycles: z.number().int().positive().default(3),
  }),
}).superRefine((config, context) => {
  if (!DateTime.now().setZone(config.timezone).isValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timezone'],
      message: 'must be a valid IANA timezone',
    });
  }

  if (config.orchestrator.heartbeatIntervalSeconds * 2 > config.orchestrator.leaseDurationSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['orchestrator', 'heartbeatIntervalSeconds'],
      message: 'must be at most half of leaseDurationSeconds so one missed heartbeat does not expire a lease',
    });
  }

  if (config.orchestrator.execution.prepareWorkspaces) {
    if (config.workspace === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspace'], message: 'is required when orchestrator.execution.prepareWorkspaces is true' });
    }
    if (Object.keys(config.repositories).length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['repositories'], message: 'must register at least one repository when orchestrator.execution.prepareWorkspaces is true' });
    }
  }

  if (config.orchestrator.execution.runAgents) {
    if (!config.orchestrator.execution.prepareWorkspaces) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['orchestrator', 'execution', 'prepareWorkspaces'], message: 'must be true when orchestrator.execution.runAgents is true' });
    }
    if (config.agents === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['agents'], message: 'is required when orchestrator.execution.runAgents is true' });
    }
    for (const tier of routedModelTiers.filter((routed) => config.models.tiers[routed] === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['models', 'tiers'], message: `must configure routed model tier ${tier} when orchestrator.execution.runAgents is true` });
    }
    for (const [name, repository] of Object.entries(config.repositories)) {
      if (repository.quality.checks.length === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['repositories', name, 'quality', 'checks'], message: 'must define at least one check when orchestrator.execution.runAgents is true' });
      }
      if (repository.quality.documentation.length > 0 && config.agents?.documentation === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['repositories', name, 'quality', 'documentation'], message: 'requires agents.documentation.root' });
      }
    }
  }

  if (config.orchestrator.execution.deliver) {
    if (!config.orchestrator.execution.runAgents) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['orchestrator', 'execution', 'runAgents'], message: 'must be true when orchestrator.execution.deliver is true' });
    }
    if (config.delivery === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['delivery'], message: 'is required when orchestrator.execution.deliver is true' });
    }
  }

  const longestRunnerMinutes = config.agents === undefined ? 0 : Math.max(...Object.values(config.agents.runner.timeoutMinutes));
  if (config.retention.runnerScratchHours * 60 <= longestRunnerMinutes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['retention', 'runnerScratchHours'], message: 'must exceed the longest agents.runner.timeoutMinutes so a running agent keeps its scratch directory' });
  }

  for (const [path, paths] of [[['sandbox', 'writablePaths'], config.sandbox.writablePaths], [['sandbox', 'readOnlyPaths'], config.sandbox.readOnlyPaths]] as const) {
    // Whole home directories hold credential files; a specific toolchain directory inside one, such as ~/.nvm, is allowed.
    if (paths.some((entry) => /^\/(?:home(?:\/[^/]+)?|root|proc(?:\/.*)?|run\/credentials(?:\/.*)?)?\/?$/.test(entry))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: 'must not expose /, a whole home directory, /proc, or systemd credentials' });
    }
  }

  const exposures: Array<{ path: string[]; names: readonly string[]; withheld: readonly string[] }> = [
    { path: ['agents', 'runner', 'environment'], names: config.agents?.runner.environment ?? [], withheld: withheldEnvironment },
    // Repository commands execute model-written code, so they never receive model credentials either.
    ...Object.entries(config.repositories).map(([name, repository]) => ({
      path: ['repositories', name, 'quality', 'environment'],
      names: repository.quality.environment,
      withheld: [...withheldEnvironment, 'OPENAI_API_KEY', 'CODEX_API_KEY'],
    })),
  ];
  for (const exposure of exposures) {
    for (const variable of exposure.names.filter((name) => exposure.withheld.includes(name))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: exposure.path, message: `must not expose orchestrator credential ${variable}` });
    }
  }

  for (const role of ['analyzer', 'reviewer'] as const) {
    const tier = config.models[role].tier;
    if (config.models.tiers[tier] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', role, 'tier'],
        message: `must reference a configured model tier: ${tier}`,
      });
    }
  }
});

export type OrchestratorConfig = z.infer<typeof configSchema>;
export type AgentsConfig = z.infer<typeof agentsSchema>;
export type QualityCommand = z.infer<typeof qualityCommandSchema>;
export type RepositoryQualityConfig = z.infer<typeof repositorySchema>['quality'];
export type DeliveryConfig = z.infer<typeof deliverySchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type CircuitBreakerConfig = z.infer<typeof circuitBreakerSchema>;
export type RetentionConfig = z.infer<typeof retentionSchema>;
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type ScheduleDay = keyof OrchestratorConfig['schedule']['days'];

export function validateConfig(input: unknown): OrchestratorConfig {
  return configSchema.parse(input);
}
