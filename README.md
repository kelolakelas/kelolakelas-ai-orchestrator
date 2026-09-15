# AI Software Engineering Orchestrator

Phase 1 of a production-oriented MVP for deterministic orchestration of AI-assisted software engineering work. The orchestrator owns workflow state, scheduling, retries, persistence, and delivery gates. AI runners will be added in later phases and return structured results only.

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

Not yet implemented: Linear/GitHub providers, worktrees, shell quality gates, AI runners, PR creation, CI polling, crash recovery, and the central scheduler loop.

Consequently, the current process validates configuration and exits. It does not discover or execute Linear issues yet.

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

## Configuration

`orchestrator.config.example.yaml` documents the Phase 1 shape. Configure:

- `timezone` with an IANA timezone such as `Asia/Jakarta`
- `schedule.days.<day>.enabled` and one or more `windows` per day
- overnight windows such as `22:00` to `03:00`
- `schedule.minimumRemainingMinutes*` guards
- `schedule.allowMechanicalOperationsOutsideHours` for future CI/status checks
- `orchestrator.maxConcurrentTasks`
- model tier identifiers under `models.tiers`; application code never accepts arbitrary model IDs from model output
- Linear filters and retry limits

Schedule override values will be wired in the scheduler phase: `normal` respects the YAML schedule, `enabled` permits execution, and `disabled` pauses new AI work after the current step.

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

Passing intake validation means the work is structurally executable by the future scheduler. It does not mean the current Phase 1 binary can read Linear Issues, run models, perform Linear discovery, implementation, delivery, or merge verification.

## Pause and resume behavior

A schedule or usage-limit pause requires a `resumeState`. The persisted task remains associated with its current worktree and stage; restart recovery must resume that stage rather than repeat completed work. A limit pause can resume only after capacity is available and the schedule is open. A schedule pause can resume only during a valid configured window.

The state machine rejects invalid transitions and rejects pause transitions without an explicit resume target.

## Service template

`systemd/ai-orchestrator.service` is a deployment template for the future long-running scheduler. Do not enable it as a production worker in Phase 1: the current binary exits after configuration validation. Once the scheduler and providers exist, run it as a dedicated non-root user, create `/etc/ai-orchestrator/orchestrator.env` with restricted permissions, install dependencies, build, migrate the database, and then enable the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ai-orchestrator
journalctl -u ai-orchestrator -f
```

Secrets belong only in the environment file or service manager secret mechanism. They must never be logged. The future startup diagnostics may report `whoami` and `HOME`, but not credential values.

## Troubleshooting

- Config errors fail startup with Zod validation details. Check time format (`HH:mm`), IANA timezone names, and required model tiers.
- If no work starts, inspect the current local time in the configured timezone and the minimum remaining-time guard.
- If a task is paused, inspect its persisted `resume_state`, `pause_reason`, and attempt counters before resuming it.
- Database operations require a reachable PostgreSQL `DATABASE_URL` and applied migrations.
- The systemd environment is intentionally separate from an interactive shell; verify the unit's `EnvironmentFile`, `WorkingDirectory`, `User`, and executable paths.
