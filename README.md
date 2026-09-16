# AI Software Engineering Orchestrator

Production-oriented MVP for deterministic orchestration of AI-assisted software engineering work. The orchestrator owns workflow state, scheduling, retries, persistence, and delivery gates. AI runners will be added in later phases and return structured results only.

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

Not yet implemented: stage handlers (repository worktrees, quality gates, AI runners), GitHub delivery, PR creation, and CI polling.

Consequently, the running service continuously audits Linear intake, persists eligible tasks, recovers expired leases, and applies operator controls, but it registers no stage handlers and therefore claims no task. Execution starts when Phases 4 and 5 register handlers.

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
- `orchestrator.pollingIntervalSeconds`, the delay between scheduler ticks
- `orchestrator.leaseDurationSeconds` and `orchestrator.heartbeatIntervalSeconds`; the heartbeat must be at most half the lease
- `orchestrator.shutdownGracePeriodSeconds`, how long `SIGTERM`/`SIGINT` waits for running stages to park
- `orchestrator.usageLimitPauseMinutes`, the default wait before resuming a usage-limit pause
- `orchestrator.http.host` and `orchestrator.http.port` for health, status, and operator endpoints (default `127.0.0.1:8089`)
- model tier identifiers under `models.tiers`; application code never accepts arbitrary model IDs from model output
- Linear filters and retry limits

The operator schedule override is persisted in PostgreSQL: `normal` respects the YAML schedule, `enabled` permits all work, and `disabled` pauses new AI work at the next stage boundary while mechanical stages follow `allowMechanicalOperationsOutsideHours`.

Environment variables:

- `DATABASE_URL` and `LINEAR_API_KEY` are required.
- `ORCHESTRATOR_DRY_RUN=true` reports intake decisions without writing to PostgreSQL, Linear, or GitHub, and rejects operator mutations.
- `ORCHESTRATOR_OPERATOR_TOKEN` enables the operator API. Without it, `/operator/*` returns 404.
- `ORCHESTRATOR_WORKER_ID` sets a stable worker identity. It must be unique per process. When set, leases held by a previous process with the same identity are recovered at startup instead of waiting for expiry.

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

Claims run in one transaction under a PostgreSQL advisory lock that counts every leased task, so the limit holds across processes. A task is claimable when it has no lease, no manual-intervention flag, and no pending cancellation, and a stage handler exists for the stage it would run:

- `QUEUED` with all blockers `COMPLETED`, when both the new-task and analysis schedule gates are open;
- `PAUSED_SCHEDULE` or `PAUSED_LIMIT` whose `resumeState` gate is open (a limit pause also waits for `resume_after`);
- an active stage parked at a boundary, such as after a graceful shutdown.

A claimed task runs stage by stage through `StageHandler` implementations. The lease is renewed every `heartbeatIntervalSeconds`, and heartbeats never overlap. Before every stage the worker re-reads the task and controls, then, in order: applies a pending cancellation, hands the task to manual intervention, parks when stopping or when new work is paused, parks when no handler exists, or enters `PAUSED_SCHEDULE` with `resumeState` when the stage gate is closed. Handlers receive an `AbortSignal` and checkpoint helpers; they return `advance`, `pause-limit`, or `interrupted`. A handler error blocks the task for manual intervention with a bounded `last_error`. A result arriving after the lease was lost is discarded.

AI stages (analysis, implementation, fix, review) need an open window with enough remaining time. Mechanical stages (testing, delivery, CI observation) may run outside hours when `allowMechanicalOperationsOutsideHours` is true. With `finishCurrentStep: false`, a running AI stage is interrupted when its window closes.

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
| `GET /operator/controls`, `/operator/tasks`, `/operator/tasks/:id`, `/operator/actions` | bearer | controls, task status with lease and error fields, and the audit log |
| `POST /operator/pause`, `/operator/resume` | bearer | stop or allow new claims across all workers; in-flight tasks park at the next stage boundary |
| `POST /operator/schedule-override` | bearer | set `normal`, `enabled`, or `disabled` |
| `POST /operator/tasks/:id/retry` | bearer | re-queue a `BLOCKED` or `FAILED` task and clear its manual-intervention markers |
| `POST /operator/tasks/:id/cancel` | bearer | cancel an unleased task now, or request cancellation that its lease owner applies at the next heartbeat |
| `POST /operator/tasks/:id/manual-intervention` | bearer | stop automatic processing; an unleased task enters `BLOCKED` when allowed |

Mutations take a JSON body `{"actor": "...", "reason": "..."}` (plus `override` for schedule overrides). Each mutation and its `operator_actions` audit row are written in one transaction. Responses exclude contract snapshots, provider payloads, and credentials.

```sh
curl -s -X POST http://127.0.0.1:8089/operator/pause \
  -H "authorization: Bearer $ORCHESTRATOR_OPERATOR_TOKEN" \
  -d '{"actor":"ops@example.com","reason":"Incident 42"}'
```

## Service template

`systemd/ai-orchestrator.service` is a deployment template for the long-running scheduler. It sets a stable per-host `ORCHESTRATOR_WORKER_ID` and a stop timeout longer than the shutdown grace period. Until stage handlers exist, enabling it runs a continuous intake auditor that claims no tasks. Run it as a dedicated non-root user, create `/etc/ai-orchestrator/orchestrator.env` with restricted permissions, install dependencies, build, migrate the database, and then enable the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ai-orchestrator
journalctl -u ai-orchestrator -f
```

Secrets belong only in the environment file or service manager secret mechanism. They must never be logged. The future startup diagnostics may report `whoami` and `HOME`, but not credential values.

## Troubleshooting

- Config errors fail startup with Zod validation details. Check time format (`HH:mm`), IANA timezone names, and required model tiers.
- If no work starts, check `GET /status` for `pauseNewWork` and `scheduleOverride`, the current local time in the configured timezone, the minimum remaining-time guards, and whether a stage handler exists for the task's stage.
- If `/readyz` fails, its `checks` object names the unavailable dependency: `database`, `linear`, or `scheduler`.
- A `BLOCKED` task with `requires_manual_intervention` was recovered from an expired lease, failed a stage, or was flagged by an operator. Inspect `GET /operator/tasks/:id` and its audit history, then retry or cancel it.
- If a task is paused, inspect its persisted `resume_state`, `pause_reason`, and attempt counters before resuming it.
- Database operations require a reachable PostgreSQL `DATABASE_URL` and applied migrations.
- The systemd environment is intentionally separate from an interactive shell; verify the unit's `EnvironmentFile`, `WorkingDirectory`, `User`, and executable paths.
