# AI Software Engineering Orchestrator

Production-oriented MVP for deterministic orchestration of AI-assisted software engineering work. The orchestrator owns workflow state, scheduling, retries, persistence, and delivery gates. AI runners return structured results only.

## Phase 1

Implemented:

- strict TypeScript service scaffold
- Zod-validated YAML configuration
- PostgreSQL/Drizzle schema for tasks and state-transition history
- explicit task state machine with validated transitions
- row-locking task claim repository using `FOR UPDATE SKIP LOCKED`
- Luxon-based operating-hours engine with named timezones, split windows, disabled days, overnight windows, and minimum remaining-time guards
- deterministic model routing, escalation policy, and retry ceilings
- versioned planning/issue intake contract with repository and dependency validation
- local JSON/YAML intake validator with duplicate, unresolved dependency, and cycle checks
- focused unit tests for state, routing, retry, and schedule behavior

Phase 2 adds read-only Linear intake. Phase 3 adds the long-running scheduler: a lease-based claim loop with a database-wide concurrency limit, operating-hours gates at stage boundaries, persisted pause/resume, lease heartbeats and stale-lease recovery, graceful shutdown, liveness/readiness/status endpoints, and audited operator controls.

Phase 4 adds isolated repository preparation: a trusted repository registry, deterministic per-task Git worktrees from the current remote base branch, repository locking, ownership markers, restart reuse, and release of clean worktrees after terminal outcomes.

Phase 5 adds supervised agent execution: a structured analyzer, a write-enabled implementer, trusted repository quality gates, bounded fix cycles, and a structured reviewer, with a diff policy and Git ownership checks before every local commit.

Phase 6 adds GitHub delivery and Linear synchronization: it pushes reviewed branches, opens exactly one pull request per repository, observes required checks, reviews, and merges on GitHub, links pull requests and delivery milestones to the Linear issue, and completes a task only when every pull request is merged and reachable from its base branch.

Phase 7 adds production hardening: quality commands in a bubblewrap sandbox, token-only Git authentication and a startup credential-exposure audit, an audited kill switch, per-repository and canary claim limits, provider circuit breakers and backpressure, Prometheus metrics with alert rules and a dashboard, artifact retention, backup and restore with a recovery drill, a credential check, a scheduler load test, and a hardened systemd unit. See [Production operations](#production-operations).

Not implemented by design: merging, deployment, and changing a Linear issue's status.

Consequently, by default the running service audits Linear intake, persists eligible tasks, recovers expired leases, and applies operator controls, but claims no task. With `orchestrator.execution.prepareWorkspaces: true` it claims tasks, prepares their worktrees, and parks them in `BLOCKED`. With `runAgents: true` as well, it analyzes, implements, tests, fixes, and reviews each task, then parks a reviewed local branch in `BLOCKED`. With `deliver: true` as well, it pushes and opens pull requests, waits for required checks and human merges, and completes the task. It never merges.

## Architecture

The orchestration boundary is intentionally deterministic:

```text
Scheduler -> TaskRepository -> StateMachine -> Operation Guard
                              |                 |
                              v                 v
                    State transition log    Agent/provider adapters
```

The state machine is the only authority for legal task movement. Every transition will be persisted before the next operation begins. A future scheduler will claim work in a database transaction, check operating hours, resume persisted pause states, and execute exactly one stage at a time.

AI is reserved for analysis, implementation, and review. Linear discovery, schedule checks, Git operations, quality commands, retry limits, and CI status are deterministic code paths.

## Local development

Supported local and CI runtime: Node.js 22.x. PostgreSQL 16 is the supported database target for migrations and future task persistence.

```sh
cp .env.example .env
npm install
npm run build
npm run lint
npm test
```

The example service validates `ORCHESTRATOR_CONFIG` at startup. Set `DATABASE_URL` before using migrations or repositories:

```sh
npm run db:generate
npm run db:migrate
npm run dev
```

`dist/` is a local build artifact and is intentionally ignored by Git. Build release artifacts in CI or the deployment pipeline; do not commit generated `dist/` output.

## Configuration

`orchestrator.config.example.yaml` documents the Phase 1 shape. Configure:

- `timezone` with an IANA timezone such as `Asia/Jakarta`
- `schedule.days.<day>.enabled` and one or more `windows` per day
- overnight windows such as `22:00` to `03:00`
- `schedule.minimumRemainingMinutes*` guards
- `schedule.allowMechanicalOperationsOutsideHours` for future CI/status checks
- `orchestrator.maxConcurrentTasks`, enforced across every process that shares the database
- `orchestrator.maxConcurrentDeliveryTasks` (default `2`), a separate limit for tasks in delivery states
- `orchestrator.pollingIntervalSeconds`, the delay between scheduler ticks
- `orchestrator.leaseDurationSeconds` and `orchestrator.heartbeatIntervalSeconds`; the heartbeat must be at most half the lease
- `orchestrator.shutdownGracePeriodSeconds`, how long `SIGTERM`/`SIGINT` waits for running stages to park
- `orchestrator.usageLimitPauseMinutes`, the default wait before resuming a usage-limit pause
- `orchestrator.http.host` and `orchestrator.http.port` for health, status, and operator endpoints (default `127.0.0.1:8089`)
- `orchestrator.execution.prepareWorkspaces` registers the workspace preparation stage (default `false`)
- `orchestrator.execution.runAgents` registers the Phase 5 agent stages (default `false`); requires `prepareWorkspaces`, `agents`, every routed model tier (`luna`, `terra`, `sol`), and quality checks for every repository
- `workspace.root`, `minimumFreeDiskMb`, `gitTimeoutSeconds`, `repositoryLockTimeoutSeconds`, and `remoteRetryMinutes`
- `orchestrator.execution.deliver` registers the Phase 6 delivery stages (default `false`); requires `runAgents`, `delivery`, and `GITHUB_TOKEN`
- `delivery.github` (`apiUrl`, `requestTimeoutMs`, `maxRetries`), `delivery.pollIntervalSeconds`, `retryIntervalSeconds`, `requiredChecksTimeoutMinutes`, `draftPullRequests`, and `linearComments`
- `repositories.<name>` for each contract repository (`web`, `api-gateway`, `academic`, `identity`, `billing`): absolute local clone `path`, `github` as `owner/name`, `remote` (default `origin`), and `baseBranch` (default `main`)
- `repositories.<name>.quality`: ordered `setup` and `checks` commands (`name`, argument array `command`, `timeoutSeconds`), extra `environment` variable names for those commands, and approved `documentation` files
- `agents.runner`: absolute agent CLI `executable`, `kind` selecting the adapter, extra runner `environment` names, per-stage `timeoutMinutes`, `maxResultBytes`, `maxEventBytes`, and `rateLimitRetryMinutes`. Deprecated in favour of `models.providers`; it still works and supplies a single provider named after its `kind`, and startup logs a warning per provider it serves. Its `executable` is required only while this block is the provider in force, so once you declare `models.providers` you can delete the whole block
- `agents.commitAuthor`, `agents.documentation` (`root`, `files`, `maxBytes`), `agents.diffPolicy`, and `agents.maxReviewDiffBytes`
- `models.providers`, each alias a `kind` (adapter), absolute `executable`, extra `environment` names that reach that provider only, and optional `effort` overrides renaming the canonical levels to the provider's own names
- `models.tiers`, each a free-form `model` name and the `provider` alias that serves it. With one provider configured no tier needs to name one; with several, every reachable tier must name one or startup fails
- `models.routes`, `models.escalation`, and `models.roles`, which replace the default complexity routes, retry ladders, and role assignments with data. Anything omitted keeps the documented default
- model identifiers are free-form strings; application code never accepts arbitrary model IDs from model output
- Linear filters and retry limits

The operator schedule override is persisted in PostgreSQL: `normal` respects the YAML schedule, `enabled` permits all work, and `disabled` pauses new AI work at the next stage boundary while mechanical stages follow `allowMechanicalOperationsOutsideHours`.

Environment variables:

- `DATABASE_URL` and `LINEAR_API_KEY` are required.
- `ORCHESTRATOR_DRY_RUN=true` reports intake decisions without writing to PostgreSQL, Linear, or GitHub, and rejects operator mutations.
- `ORCHESTRATOR_OPERATOR_TOKEN` enables the operator API. Without it, `/operator/*` returns 404.
- `GITHUB_TOKEN` is required when `deliver` is true. It authenticates GitHub API reads and pull request creation only; it never reaches Git, agents, or quality commands. Pushes use the service user's Git credentials, like fetches.
- `ORCHESTRATOR_WORKER_ID` sets a stable worker identity. It must be unique per process. When set, leases held by a previous process with the same identity are recovered at startup instead of waiting for expiry.

### Model providers

A *provider* is an alias for an executable that runs a model. `models.providers.<alias>.kind` selects the adapter, and capabilities belong to the adapter, not to configuration:

| `kind` | Own command confinement | Wrappable by `sandbox.kind: bubblewrap` |
| --- | --- | --- |
| `codex-cli` | yes (`codex exec --sandbox`) | no, bubblewrap cannot nest inside bubblewrap |

An adapter declares its own confinement because it is the only party that knows how it isolates model-issued commands. Configuration cannot widen a capability: the registry computes each provider's effective confinement from its adapter, and startup rejects any write-capable role (implementer or fixer) whose provider would leave commands unconfined. Adding a provider therefore means adding an adapter, not loosening a check.

`models.providers.<alias>.environment` lists the extra variables that reach that provider's runs. Orchestrator credentials and every known provider credential are refused wherever repository quality commands could read them; a provider's own credential is expected, because that is how the provider authenticates.

`models.providers.<alias>.effort` renames the canonical effort levels (`low`, `medium`, `high`, `max`) to whatever the provider calls them. Leaving it out uses the adapter's defaults; for `codex-cli` the default maps `max` to `xhigh`.

`models.tiers.<tier>` pairs a free-form `model` name with the `provider` alias that serves it. With a single provider configured, no tier needs to name one and every tier uses it. With several, each reachable tier must name its provider or startup fails, so no attempt is routed by guesswork. `models.routes`, `models.escalation`, and `models.roles` likewise override the default complexity routes, retry ladders, and role assignments. The `agents.runner` block is deprecated: it still works, serves exactly one provider named after its `kind`, and logs a warning at startup. Declaring `models.providers` is what lets you go on to delete it, because `agents.runner.executable` is only required while that block is the provider in force.

## Planning intake contract

Planning output is machine-checkable through `kelolakelas.planning-backlog/v1`. The contract treats Projects as organizational outcome containers and Issues as executable queue units. Each issue declares an exact repository set, matching repository labels plus `ai-ready`, stable draft dependency keys, structured external dependencies, acceptance criteria, validation requirements, and a required execution `complexity`.

`estimate` (`S`, `M`, `L`) describes relative planning effort. `complexity` (`very-low`, `low`, `medium`, `high`, `very-high`, or `critical`) describes AI execution difficulty and risk; it is chosen independently and must be identical in the Linear Issue metadata, its `AI Orchestrator Contract`, and the planning payload. High-or-greater complexity requires an explicit risk in Technical Notes and a mitigation or risk validation in Testing / Validation. The deterministic first attempt is `very-low -> luna/medium`, `low -> luna/high`, `medium -> terra/medium`, `high -> terra/high`, `very-high -> sol/medium`, and `critical -> sol/high`. Retries may only increase tier or effort; `max` effort is reserved for an explicit retry escalation, including a critical retry.

Validate a YAML or JSON planning artifact before creating Linear records:

```sh
npm run intake:validate -- docs/planning-backlog.example.yaml
```

The safe publication order is:

1. Validate the complete planning backlog without `source` data.
2. Create Projects and Issues without the `ai-ready` label.
3. Resolve draft keys to Linear identifiers and create native `blockedBy` relations.
4. Refetch Linear state, let the provider hydrate `source`, and validate the complete graph again.
5. Add `ai-ready` only after repository labels, issue contracts, and native relations agree.

The `AI Orchestrator Project Contract` section in each Linear Project description contains its project object, and the `AI Orchestrator Contract` section in each Linear Issue contains its issue object. A future Linear provider must assemble the associated objects into a backlog, add actual source metadata, and validate the entire graph. Issue-authored claims never count as runtime evidence for status, CI, approval, merge, or Git reachability.

Passing intake validation means the work is structurally executable by the future scheduler. It does not enable model execution, implementation, delivery, or merge verification.

Phase 2 also supports read-only Linear discovery in dry-run mode. It queries only the configured team, filters required/excluded labels and terminal states, validates and hydrates each `AI Orchestrator Contract`, then writes a structured eligible/quarantined/ignored report to logs on every tick. It reads operator controls from PostgreSQL but never writes to Linear, GitHub, Git, or PostgreSQL.

```sh
DATABASE_URL=... ORCHESTRATOR_DRY_RUN=true LINEAR_API_KEY=... npm run dev
```

## Scheduler

Each tick, spaced by `pollingIntervalSeconds` after the previous tick completes:

1. reads operator controls from PostgreSQL;
2. blocks tasks whose lease expired, marking them for manual intervention (a state that cannot enter `BLOCKED` keeps its state and is only flagged);
3. polls Linear intake (read-only, so it runs regardless of schedule and pause);
4. claims executable tasks until `maxConcurrentTasks` leases exist.

Claims run in one transaction under a PostgreSQL advisory lock that counts leased tasks, so the limit holds across processes. Delivery states (`PR_CREATED`, `WAITING_CI`, `READY_FOR_HUMAN_REVIEW`) form a separate claim lane limited by `maxConcurrentDeliveryTasks`, claimed before execution work, so a pull request that waits days for review never occupies an execution slot. A task is claimable when it has no lease, no manual-intervention flag, and no pending cancellation, and a stage handler exists for the stage it would run:

- `QUEUED` with all blockers `COMPLETED`, when both the new-task and analysis schedule gates are open;
- `PAUSED_SCHEDULE` or `PAUSED_LIMIT` whose `resumeState` gate is open (a limit pause also waits for `resume_after`);
- an active stage parked at a boundary, such as after a graceful shutdown, once its `resume_after` (set by a waiting stage) has passed.

A claimed task runs stage by stage through `StageHandler` implementations. The lease is renewed every `heartbeatIntervalSeconds`, and heartbeats never overlap. Before every stage the worker re-reads the task and controls, then, in order: applies a pending cancellation, hands the task to manual intervention, parks when stopping or when new work is paused, parks when no handler exists, or enters `PAUSED_SCHEDULE` with `resumeState` when the stage gate is closed. Handlers receive an `AbortSignal` and checkpoint helpers; they return `advance`, `pause-limit`, `wait`, or `interrupted`. `wait` keeps the state, releases the lease, and sets `resume_after`, without a transition record. A handler error blocks the task for manual intervention with a bounded `last_error`. A result arriving after the lease was lost is discarded.

AI stages (analysis, implementation, fix, review) need an open window with enough remaining time. Mechanical stages (testing, delivery, CI observation) may run outside hours when `allowMechanicalOperationsOutsideHours` is true. With `finishCurrentStep: false`, a running AI stage is interrupted when its window closes.

## Repository preparation

When `prepareWorkspaces` is enabled, the `ANALYZING` stage prepares one worktree per repository declared by the validated contract, then parks the task in `BLOCKED` with the reason `Workspaces prepared; no analyzer stage is registered`. An operator retry after Phase 5 is deployed reuses the same worktrees.

For each repository, under a PostgreSQL advisory lock named for that repository:

1. The registry resolves the repository. Registry paths are canonicalized at startup and must not overlap each other or the workspace root. Repositories absent from the registry or the contract cannot be opened.
2. The local clone must be a Git top level whose configured remote URL points at the registered GitHub repository. `url.<base>.insteadOf` rewrites are trusted host configuration.
3. The branch is the Linear `branchName` from the hydrated contract, validated with `git check-ref-format`. The worktree path is `<workspace.root>/<taskId>/<repository>`.
4. An existing valid worktree is reused without fetching or moving its base. It must be locked by the orchestrator, carry matching ownership markers, and descend from its recorded base commit. This includes a worktree created before a crash prevented the database write.
5. Otherwise the worker requires that the branch does not exist on the remote, fetches the base branch, fast-forwards local `main` when that is safe, checks free disk space, writes ownership markers, and runs `git worktree add --lock` at the fetched commit. The new worktree must be a clean checkout of that commit inside the root.
6. The workspace path, branch, and base commit are persisted on the work unit while the lease is held. Unique indexes prevent two work units from recording the same repository branch or workspace path.

Ownership markers are branch config values in the clone (`branch.<name>.orchestratortask`, `orchestratorbase`, `orchestratorworktree`) plus the worktree lock reason `kelolakelas-ai-orchestrator task=<id> repository=<name>`.

Outcomes:

- **Unreachable remote:** `PAUSED_LIMIT` with `REMOTE_UNAVAILABLE`, resumed after `remoteRetryMinutes`.
- **Unmerged dependency, user-owned or foreign branch, unexpected path, missing persisted worktree, rewritten history, remote branch already present, wrong remote, or insufficient disk:** `BLOCKED` for manual intervention with the reason in `last_error`. Stacked PRs are not expressible in the planning contract, so an unmerged dependency always blocks.

Git runs as a fixed executable with argument arrays, repository hooks disabled (`core.hooksPath=/dev/null`), a timeout, bounded output, and an environment limited to `PATH`, `HOME`, `USER`, `LOGNAME`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, and `TMPDIR`. Provider tokens and `DATABASE_URL` are never passed to Git.

Every tick, workspaces of `COMPLETED` and `CANCELLED` tasks are released. A worktree is removed only when it is registered at the orchestrator path, locked by the orchestrator for that task, marked for that task, and has no uncommitted or untracked files; removal never uses `--force`. Branches and their commits are kept. A worktree that cannot be released keeps `workspace_cleanup_blocked_reason` on its work unit and is retried on later ticks.

## Supervised agent execution

With `runAgents` enabled, a claimed task runs these stages. Each one is a stage handler, so the scheduler applies schedule gates, operator controls, heartbeats, and cancellation between them.

| Stage | Work | Success | Failure |
|---|---|---|---|
| `ANALYZING` | Prepare worktrees, then a read-only analyzer returns a plan | `READY` | Invalid output, a plan that does not cover exactly the contract repositories, or a clarification request: `BLOCKED` for manual intervention |
| `READY` | Run each repository's `setup` commands, then discard their artifacts | `IMPLEMENTING` | Setup failure: `BLOCKED` for manual intervention |
| `IMPLEMENTING` | A workspace-write implementer changes the worktrees; the orchestrator verifies Git state, applies the diff policy, and commits locally | `TESTING` | Timeout, runner failure, invalid output, or rejected diff: discard changes and retry through `READY` with the next escalation route; `FAILED` after `maxImplementationAttempts` |
| `TESTING` | Run `setup` and every `check`, then discard artifacts | `REVIEWING` | Request a fix (`FIXING`); `FAILED` after `maxQualityFixAttempts`; a command that cannot start blocks for manual intervention |
| `FIXING` | A workspace-write fixer addresses the failing output or review findings, with the same checks as implementation | `TESTING` | An unapplied or rejected fix returns to `TESTING`, which consumes the next bounded attempt |
| `REVIEWING` | A read-only reviewer inspects the committed diff | `PR_CREATED` when delivery is enabled; otherwise `BLOCKED` with the reason `Reviewed local branch ready; delivery is not enabled` and no manual-intervention flag | Requested changes: `FIXING`; `FAILED` after `maxReviewCycles`. Rejection or invalid output: `BLOCKED` for manual intervention |

A reviewer approval with a blocker or major finding counts as a change request. Provider usage limits pause the task in `PAUSED_LIMIT` (`USAGE_LIMIT`, using the provider's retry hint or `usageLimitPauseMinutes`; the pre-registry `CODEX_USAGE_LIMIT` is still recognised so older rows resume), and rate limits pause it with `RATE_LIMIT` for `rateLimitRetryMinutes`. Pauses and cancellations do not consume an attempt. Implementation attempts, quality fixes, and review cycles are counted on the task and each increment is written in the transition that consumes it. An operator retry of a `FAILED` task resets the counters for one new bounded cycle.

Every stage checkpoints its result against the exact commits it verified: an accepted plan, completed setup, the committed implementation, passing gates, an applied fix, and a review approval. A resumed, parked, or retried stage reuses them. Retrying a task parked with a reviewed branch re-verifies the workspaces and quality gates without calling an agent again.

**Model routing.** The implementer's model and effort come from the escalation route for the contract complexity and attempt number: `models.routes` for the deterministic first attempt, `models.escalation` for retries, and the built-in defaults for anything omitted. Fixes reuse the latest implementation route. The analyzer and reviewer use `models.roles` when it pins them, otherwise `models.analyzer` and `models.reviewer`. Every route resolves to a tier, and every tier to a provider alias and a free-form model name, so which provider serves which work is configuration. Model identifiers are always read from configuration, never from model output.

**Runner.** Each provider alias is served by an adapter selected by its `kind`. The `codex-cli` adapter runs `codex exec --json --ephemeral --ignore-user-config --ignore-rules` in the task directory, which contains only the declared worktrees. The analyzer and reviewer use the `read-only` sandbox; the implementer and fixer use `workspace-write` with network access disabled and `/tmp` excluded, so their only writable locations are the task directory and a private per-run `TMPDIR`. A runner receives `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `XDG_CONFIG_HOME`, plus the `environment` names its own provider alias lists; agent shell commands inherit only core variables. Each run has a timeout, cancellation through the stage abort signal, an event-stream size limit, a result size limit, and process-group termination. The final message must match a strict versioned JSON schema: `kelolakelas.agent.analysis/v1`, `implementation/v1`, `fix/v1`, or `review/v1`. No result field can name a command, tool, model, credential, or path outside the declared repositories.

**Prompts.** Prompts contain the validated contract, the accepted plan, approved documentation loaded from `agents.documentation`, and redacted command output or review findings. All of it is wrapped as untrusted data that cannot change instructions. Attempt records store the prompt SHA-256, size, and template version, not the prompt.

**Before every commit.** The orchestrator re-verifies each worktree: its Git directory still belongs to the registered clone, HEAD is on the task branch and unmoved by the agent, ownership markers and the lock reason match, and history descends from the base. It then stages all changes and rejects the whole attempt when any repository has:

- no change in a repository the contract requires (implementation), or no change at all;
- more than `maxChangedFiles` files, `maxChangedLines` lines, or `maxUnplannedFiles` files outside the accepted plan;
- a path matching `forbiddenPaths` (defaults: `.git`, `.github`, `.gitmodules`, `CODEOWNERS`, `.husky`, `.npmrc`, `AGENTS.md`, `CLAUDE.md`, `.codex`, `.claude`, `.env` variants, `*.pem`, `*.key`, `id_rsa*`) or `generatedPaths` (defaults: `node_modules`, `dist`, `coverage`, `.next`, minified assets);
- binary content outside `allowedBinaryPaths`, a symbolic link, or a submodule;
- an added line matching a credential pattern or the literal value of a credential in the orchestrator environment.

Commits use `agents.commitAuthor`, run with hooks disabled, and carry `Orchestrator-Task` and `Orchestrator-Stage` trailers. Nothing is pushed until delivery re-verifies the branch.

**Quality gates.** `setup` and `checks` come only from `repositories.<name>.quality` and run as argument arrays in the worktree, without a shell, with a timeout, bounded output, and process-group termination. They receive `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `CI=true`, and the names in `quality.environment`. Configuration rejects every orchestrator credential and every known provider credential there, including `OPENAI_API_KEY`, `CODEX_API_KEY`, and `ANTHROPIC_API_KEY`. Output tails are redacted before they are stored or shown to a fixer.

**Evidence.** Each stage run is a `task_attempts` row with its normalized `input`, schema-validated `result`, redacted `evidence` (quality outcomes, diff statistics, policy findings, commits), `usage` tokens, and `failure_category`. `GET /operator/tasks/:id` returns them with the task's attempt counters and selected model tier.

**Trust boundary limits.** Quality commands execute code written by the agent, outside the provider's command sandbox, with the service user's permissions minus credentials. A sandbox limits writes, not reads: an agent can read any file the service user can read. Run the service as a dedicated user that cannot read secrets or other users' files, and keep `/etc/ai-orchestrator/orchestrator.env` root-owned. Delivery raises the stakes: see [Delivery trust boundary](#delivery-trust-boundary).

## GitHub delivery and Linear synchronization

With `deliver` enabled, a reviewed task continues through three delivery stages. They run in the delivery claim lane and are mechanical, so they follow `allowMechanicalOperationsOutsideHours`.

| Stage | Work | Success | Waits | Blocks for manual intervention |
|---|---|---|---|---|
| `PR_CREATED` | Verify, push, and create or recover one pull request per repository; link each to the Linear issue | `WAITING_CI` | GitHub, Git remote, or Linear unavailable or rate limited | Unapproved or ungated commits, a foreign commit or diff-policy violation, a diverged or deleted remote branch, a closed, duplicated, retargeted, or rewritten pull request, an archived repository, or a GitHub rejection |
| `WAITING_CI` | Observe every pull request's required checks | `READY_FOR_HUMAN_REVIEW` when every open pull request passed its required checks (merged ones count) | Required checks missing or pending, every `pollIntervalSeconds` | A failed, skipped, cancelled, or otherwise unsuccessful required check; checks still missing or pending after `requiredChecksTimeoutMinutes`; no required checks at all; merge conflicts; a closed, retargeted, or force-pushed pull request |
| `READY_FOR_HUMAN_REVIEW` | Observe reviews and merges | `COMPLETED` when every pull request is merged and its merge commit is reachable from the remote base branch; back to `WAITING_CI` when a head moved and checks run again | Awaiting review or merge; a merge commit not yet reachable | As in `WAITING_CI`, plus a merge commit that stays unreachable past the timeout |

**Before anything leaves the host**, `PR_CREATED` requires the review approval and quality pass checkpoints for the current commits and re-verifies each worktree's ownership and registered remote. Every commit between the base and the head must be a single-parent commit by `agents.commitAuthor` carrying this task's `Orchestrator-Task` trailer. The cumulative diff is re-inspected against the diff policy's content rules (forbidden and generated paths, binaries, symbolic links, submodules, and secrets). The push is `git push --porcelain --no-verify <remote> <commit>:refs/heads/<branch>`: never forced, with hooks disabled.

**Required checks and approvals come from GitHub.** Each observation reads the base branch's classic protection and rulesets. Only an explicit `success` counts; a requirement pinned to a GitHub App matches only that app's check runs. A base branch that requires no checks is treated as a misconfigured merge gate. Approvals are observed and reported, including the ruleset's required count when GitHub exposes it; GitHub enforces them at merge. Nothing in a Linear issue can supply check, approval, or merge state.

**The orchestrator never merges.** A pull request whose head moves forward from the reviewed commit, for example through "Update branch", stays valid and its checks are observed again. A head that no longer contains the reviewed commit is treated as a force-push.

**Partial delivery.** Each repository work unit records its own delivery state (`PR_CREATED`, `WAITING_CI`, `READY_FOR_HUMAN_REVIEW`, `COMPLETED`, or `BLOCKED`), outcome, pushed commit, pull request, merge commit, and latest GitHub observation. The parent task completes only when every work unit is `COMPLETED`.

**Idempotency.** Every side effect first records an intent row in `external_operations` keyed by task, repository, and commit or event, and each one is reconciled with the external system before it acts:

- A push reads the remote branch first.
- A pull request is looked up by head branch, and GitHub refuses a second open pull request for the same head.
- A Linear comment carries its key in the body and is looked up after an unrecorded attempt.
- A Linear attachment is keyed by URL.

A retry after a crash, a lost response, or an operator retry therefore converges without duplicates. Writes are never retried blindly inside the GitHub or Linear adapters.

**Linear.** Pull requests are attached to the issue. When `linearComments` is true, one comment is posted per milestone: pull requests opened, required checks passed, delivery blocked, and every pull request merged. The orchestrator never changes an issue's status; a person moves it to Done after checking the acceptance criteria. Milestone comments are retried until they succeed; a blocked notification is best effort and never delays blocking.

**GitHub access.** `GITHUB_TOKEN` must be able to read repository metadata, branch protection or rulesets, pull requests, check runs, commit statuses, and reviews, and to create pull requests. Pushes use the service user's Git credentials, so that account needs push access to task branches only. Protect `main` so the account cannot push to it.

### Delivery trust boundary

Agents and quality commands run agent-written code as the service user. A process running as that user can read the orchestrator's environment (`/proc/<pid>/environ`), which holds `GITHUB_TOKEN` and the other credentials, and any credential file the user can read. Three controls close that exposure, and delivery refuses to start until the startup audit finds none missing:

1. **Command sandbox** (`sandbox.kind: bubblewrap`). Every setup and check command runs in new user, PID, IPC, UTS, and network namespaces with a fresh `/proc`, so orchestrator processes and their environments are invisible. Only `sandbox.readOnlyPaths` and the worktree are mounted, `sandbox.maskedPaths` are emptied, and there is no home directory. Checks get no network unless a command sets `network: true`; setup commands get network by default. A provider that already runs model-issued commands in its own PID-namespaced sandbox is not wrapped again: bubblewrap cannot nest inside bubblewrap.
2. **Token-only Git** (`workspace.gitAuthentication: github-token`). Fetches and pushes authenticate with `GITHUB_TOKEN` through Git's environment-only configuration; host credential helpers are cleared and SSH is refused. The service user needs no Git credentials.
3. **Credential-exposure audit.** At startup the orchestrator reports a disabled sandbox, host Git authentication, readable files in `security.credentialFiles` (for example `~/.git-credentials`, `~/.config/gh/hosts.yml`, private SSH keys, or `/etc/ai-orchestrator/orchestrator.env`), a password-less `DATABASE_URL`, and a configuration writable by group or others. With `deliver` enabled any finding stops startup unless `security.acceptCredentialExposure` is set, which is meant only for a non-production sandbox.

Remaining exposure: a provider's own model credential is readable by model-issued commands; the sandbox cannot restrict reads inside mounted paths; and processes with network access can reach local services such as PostgreSQL, which therefore requires password authentication. Use a fine-grained token limited to the registered repositories, and branch protection that requires review.

## Pause and resume behavior

A schedule or usage-limit pause requires a `resumeState` that the paused state can legally resume to. Pausing releases the lease. A limit pause resumes only after its `resume_after` time and when the schedule gate for its `resumeState` is open. A schedule pause resumes only when the gate for its `resumeState` opens. Stage handlers must be idempotent with respect to their checkpoints, because a resumed or parked stage runs again.

The state machine rejects invalid transitions and rejects pause transitions without an explicit resume target.

## Shutdown and recovery

On `SIGTERM` or `SIGINT` the worker stops claiming, aborts running stages, and waits up to `shutdownGracePeriodSeconds`. A stage that returns `interrupted` is parked with its lease released and can be claimed by any worker. A stage that does not finish in time keeps its lease: the lease expires and recovery blocks the task for manual intervention. A second signal exits immediately with the same outcome. Readiness fails as soon as shutdown begins.

Forced termination (`SIGKILL`, crash, host loss) leaves the lease in place. Another worker blocks the task after the lease expires, or the restarted process does so immediately when `ORCHESTRATOR_WORKER_ID` is stable. Automatic replay of an interrupted stage is intentionally not performed; an operator retries after inspecting the task.

## Health, status, and operator API

The HTTP server binds to `127.0.0.1:8089` by default. Do not expose it publicly.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | 200 unless a scheduler tick has run longer than the stuck threshold |
| `GET /readyz` | none | 200 only when PostgreSQL answers, the last Linear poll succeeded, and the worker is not stopping |
| `GET /status` | none | worker state, last tick and intake result, in-flight tasks, and task counts by state |
| `GET /operator/controls`, `/operator/tasks`, `/operator/tasks/:id`, `/operator/actions` | bearer | controls, task status with lease, error, attempt-counter, and model fields, per-repository work units with delivery state and pull requests, stage attempts (task detail), and the audit log |
| `POST /operator/pause`, `/operator/resume` | bearer | stop or allow new claims across all workers; in-flight tasks park at the next stage boundary |
| `POST /operator/schedule-override` | bearer | set `normal`, `enabled`, or `disabled` |
| `POST /operator/tasks/:id/retry` | bearer | re-queue a `BLOCKED` or `FAILED` task and clear its manual-intervention markers |
| `POST /operator/tasks/:id/cancel` | bearer | cancel an unleased task now, or request cancellation that its lease owner applies at the next heartbeat |
| `POST /operator/tasks/:id/manual-intervention` | bearer | stop automatic processing; an unleased task enters `BLOCKED` when allowed |
| `POST /operator/kill-switch` | bearer | `{"engaged": true}` stops every stage and maintenance on all workers; running stages stop at a safe point and park with their state and checkpoints. `false` releases it |
| `GET /metrics` | none | Prometheus metrics (disable with `orchestrator.http.metrics: false`); no task, issue, or credential identifiers |

Mutations take a JSON body `{"actor": "...", "reason": "..."}` (plus `override` for schedule overrides and `engaged` for the kill switch). Each mutation and its `operator_actions` audit row are written in one transaction. Responses exclude contract snapshots, provider payloads, and credentials.

```sh
curl -s -X POST http://127.0.0.1:8089/operator/pause \
  -H "authorization: Bearer $ORCHESTRATOR_OPERATOR_TOKEN" \
  -d '{"actor":"ops@example.com","reason":"Incident 42"}'
```

## Production operations

Procedures (incident response, stuck workflows, kill switch, backup and restore, credential rotation, canary rollout, and recovery exercises) are in the operations runbook: `kelolakelas-docs/docs/runbooks/ai-orchestrator-operations.md`.

- **Kill switch.** `POST /operator/kill-switch`, or `ORCHESTRATOR_KILL_SWITCH=true` for one worker when PostgreSQL is not trusted, for example right after a restore. Intake keeps running because it is read-only. Every engage and release is audited.
- **Canary rollout.** `orchestrator.rollout.repositories` limits new tasks to listed repositories, and `maxNewTasksPerDay` caps task starts in any rolling 24 hours across workers. Started tasks are never stranded by narrowing it.
- **Concurrency.** `repositories.<name>.maxConcurrentTasks` caps leased execution tasks touching a repository across workers. Each claim lane refills for at most one polling interval per tick, so many fast delivery observations cannot starve execution or intake.
- **Backpressure.** GitHub and Linear calls go through per-process circuit breakers (`providers.circuitBreaker`). An open GitHub circuit holds delivery claims, and a runner usage or rate limit holds execution claims until the limit resets.
- **Metrics and alerts.** `GET /metrics` exports queue size and age per state, stage duration and outcomes, CI wait (`orchestrator_state_dwell_seconds{state="WAITING_CI"}`), attempts by failure category, stale leases, provider calls and circuit state, model tokens and estimated cost (`metrics.modelPricing`), and control state. `ops/prometheus/alerts.yml` (with promtool tests) and `ops/grafana/ai-orchestrator-dashboard.json` use only these metrics; a unit test keeps them in sync.
- **Retention.** Every `retention.intervalMinutes`, attempt evidence and checkpoint payloads of `COMPLETED`/`CANCELLED` tasks older than `terminalTaskArtifactDays` are removed, as are quarantines unseen for `quarantineDays` and runner scratch directories older than `runnerScratchHours`. Tasks, transitions, attempt inputs, results, usage, external operations, and operator actions are kept as the audit record.
- **Backup and restore.** `node dist/src/ops/backup.js <dir> [keepDays]` writes a checksummed custom-format dump and manifest; `systemd/ai-orchestrator-backup.timer` runs it every 6 hours. `RESTORE_DATABASE_URL=... node dist/src/ops/restore.js <dump>` restores only into an empty database, in one transaction, and verifies row counts and migrations. Credentials reach `pg_dump`, `pg_restore`, and `psql` only through libpq environment variables. `tests/backup-restore.integration.test.ts` is the recovery drill.
- **Credential check.** `node dist/src/ops/check-credentials.js` verifies, read-only, that `LINEAR_API_KEY` reads the team and `GITHUB_TOKEN` reads every registered repository, branch policy, and pull requests; it fails classic tokens with unneeded scopes and warns before expiry. Run it after every rotation.
- **Load test.** `LOAD_TEST_DATABASE_URL=... npm run load:scheduler` runs several workers against a disposable database and fails if any execution, delivery, or repository limit is exceeded.
- **Sandbox delivery run.** `ops/sandbox/orchestrator.sandbox.yaml` configures a run against a disposable GitHub repository and Linear team; `node dist/src/ops/sandbox-evidence.js <IDENTIFIER>` records the run and verifies exactly one pull request per work unit.

## Service template

`systemd/ai-orchestrator.service` is a hardened deployment template. It sets a stable per-host `ORCHESTRATOR_WORKER_ID`, a stop timeout longer than the shutdown grace period, `KillMode=control-group`, memory and task limits for the whole service including agents, and filesystem and system-call restrictions that the command sandbox tolerates. `ProtectKernelTunables`, `ProtectKernelLogs`, and `ProtectHostname` are left out on purpose: they make the kernel refuse the sandbox's `/proc` mount, and the orchestrator's startup sandbox check would fail. Hosts must allow unprivileged user namespaces (on Ubuntu 24.04, `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile for `bwrap`).

Run it as the dedicated `ai-orchestrator` user with a home under `/var/lib/ai-orchestrator/home` that holds no credentials. Create `/etc/ai-orchestrator/orchestrator.env` owned by `root:root` with mode `0600`; systemd reads it before dropping privileges. Keep the configuration at `/etc/ai-orchestrator/orchestrator.yaml`, writable only by root. Install dependencies, build, migrate the database, and then enable the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ai-orchestrator ai-orchestrator-backup.timer
journalctl -u ai-orchestrator -f
```

Secrets belong only in the environment file or service manager secret mechanism. They are never logged.

## Troubleshooting

- Config errors fail startup with Zod validation details. Check time format (`HH:mm`), IANA timezone names, and required model tiers. When several providers are configured, a reachable tier that names none is rejected; when a write-capable role would run unconfined commands, the message names the provider and its `kind`.
- `tests/provider-fence.test.ts` fails the build when provider-specific vocabulary such as a CLI flag, an event type, a usage field, or a model identifier pattern appears outside the adapter modules, the fixtures, and the example config. Add those strings there, in the adapter that owns them, not in shared code.
- If no work starts, check `GET /status` for `pauseNewWork`, `scheduleOverride`, `killSwitch` (and `killSwitchSource`), and `laneHolds`, the `orchestrator.rollout` limits and repository `maxConcurrentTasks`, the current local time in the configured timezone, the minimum remaining-time guards, and whether a stage handler exists for the task's stage.
- If `/readyz` fails, its `checks` object names the unavailable dependency: `database`, `linear`, or `scheduler`.
- A task `BLOCKED` during preparation names the conflict in `last_error`. Resolve it in the local clone (for example remove a stale branch you own, or push the dependency), then retry the task. Never delete a worktree carrying the orchestrator lock reason while its task is active.
- A work unit with `workspace_cleanup_blocked_reason` still has its worktree. Commit, move, or discard the listed changes; the next tick retries the release.
- A `BLOCKED` task with `requires_manual_intervention` was recovered from an expired lease, failed a stage, or was flagged by an operator. Inspect `GET /operator/tasks/:id` and its audit history, then retry or cancel it.
- If a task is paused, inspect its persisted `resume_state`, `pause_reason`, and attempt counters before resuming it.
- A `BLOCKED` task without `requires_manual_intervention` whose last transition reason is `Reviewed local branch ready; delivery is not enabled` has a committed, gated, reviewed branch in its worktrees. Inspect it with `git log <base>..HEAD` in each worktree.
- A task in `WAITING_CI` or `READY_FOR_HUMAN_REVIEW` without a lease is waiting: `resume_after` is the next observation. `GET /operator/tasks/:id` lists each work unit's pull request, delivery state, outcome, and the last required-check and review observation.
- A delivery `BLOCKED` task names the repository and reason in `last_error`. Fix the cause on GitHub, for example rerun a failed check, reopen a closed pull request, restore a force-pushed branch, or configure required checks, then retry the task. Retrying re-verifies every stage without calling an agent and reuses the recorded push, pull request, and Linear updates. A pull request closed on purpose, or a task that should not be delivered, is cancelled instead.
- Disabling `deliver` leaves tasks already in delivery states unclaimed until it is enabled again.
- For an agent stage that blocked or failed, `GET /operator/tasks/:id` lists attempts with `failureCategory` (`invalid-output`, `needs-clarification`, `diff-rejected`, `workspace-integrity`, `quality-failed`, `quality-infrastructure`, `review-rejected`, and others) and redacted evidence. Fix the contract or configuration, then retry the task; accepted plans and commits are reused.
- A `workspace-integrity` failure means an agent changed Git state (committed, switched branch, or rewrote the worktree's `.git` file). Inspect the worktree before retrying; the orchestrator does not repair it.
- Startup fails with `credential exposure audit reported N finding(s)`: the preceding `credential_exposure_finding` log lines name each check and path. Fix them rather than setting `security.acceptCredentialExposure`.
- Startup fails with `Command sandbox bubblewrap failed its startup check`: the host blocks unprivileged user namespaces, `sandbox.executable` is wrong, or a systemd option hides `/proc`. Run the probe from the runbook as the service user.
- A quality command fails only in the sandbox: a tool outside `sandbox.readOnlyPaths` (for example a Node.js installation under `/opt/node`), a cache directory that must be listed in `sandbox.writablePaths`, or a check that needs `network: true`.
- Database operations require a reachable PostgreSQL `DATABASE_URL` and applied migrations.
- The systemd environment is intentionally separate from an interactive shell; verify the unit's `EnvironmentFile`, `WorkingDirectory`, `User`, and executable paths.
