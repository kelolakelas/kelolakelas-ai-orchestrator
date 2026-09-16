import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const persistedTaskStates = [
  'QUEUED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING',
  'PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW', 'PAUSED_SCHEDULE', 'PAUSED_LIMIT',
  'BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED',
] as const;

const persistedTaskComplexities = [
  'very-low', 'low', 'medium', 'high', 'very-high', 'critical',
] as const;

export const taskStateEnum = pgEnum('task_state', [...persistedTaskStates]);
export const taskComplexityEnum = pgEnum('task_complexity', [...persistedTaskComplexities]);

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  linearIssueId: text('linear_issue_id').notNull().unique(),
  linearIdentifier: text('linear_identifier').notNull(),
  contractSnapshot: jsonb('contract_snapshot').$type<Record<string, unknown>>().notNull().default({}),
  repository: text('repository'),
  workspacePath: text('workspace_path'),
  branch: text('branch'),
  state: taskStateEnum('state').notNull().default('QUEUED'),
  resumeState: taskStateEnum('resume_state'),
  complexity: taskComplexityEnum('complexity'),
  risk: text('risk'),
  selectedModelTier: text('selected_model_tier'),
  selectedModel: text('selected_model'),
  reasoningEffort: text('reasoning_effort'),
  implementationAttempts: integer('implementation_attempts').notNull().default(0),
  qualityFixAttempts: integer('quality_fix_attempts').notNull().default(0),
  reviewAttempts: integer('review_attempts').notNull().default(0),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  pauseReason: text('pause_reason'),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  lastError: text('last_error'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  requiresManualIntervention: boolean('requires_manual_intervention').notNull().default(false),
  resumeAfter: timestamp('resume_after', { withTimezone: true }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stateTransitions = pgTable('state_transitions', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  fromState: taskStateEnum('from_state'),
  toState: taskStateEnum('to_state').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // State age, dwell time, and the rollout start budget read the latest transitions of a task.
  index('state_transitions_task_id_created_at_idx').on(table.taskId, table.createdAt),
  index('state_transitions_to_state_created_at_idx').on(table.toState, table.createdAt),
]);

export const taskDependencies = pgTable('task_dependencies', {
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  blockerTaskId: uuid('blocker_task_id').notNull().references(() => tasks.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.blockerTaskId] }),
  index('task_dependencies_blocker_task_id_idx').on(table.blockerTaskId),
]);

export const taskWorkUnits = pgTable('task_work_units', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  repository: text('repository').notNull(),
  state: taskStateEnum('state').notNull().default('QUEUED'),
  outcome: text('outcome'),
  workspacePath: text('workspace_path'),
  branch: text('branch'),
  baseCommit: text('base_commit'),
  workspaceReleasedAt: timestamp('workspace_released_at', { withTimezone: true }),
  workspaceCleanupBlockedReason: text('workspace_cleanup_blocked_reason'),
  /** Reviewed commit pushed to the remote task branch. */
  pushedCommit: text('pushed_commit'),
  pullRequestNumber: integer('pull_request_number'),
  pullRequestUrl: text('pull_request_url'),
  /** Merge commit observed on GitHub and verified reachable from the remote base branch. */
  mergeCommit: text('merge_commit'),
  /** Latest normalized GitHub observation: pull request state, required checks, and reviews. */
  deliveryObservation: jsonb('delivery_observation').$type<Record<string, unknown>>(),
  deliveryObservedAt: timestamp('delivery_observed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('task_work_units_task_repository_unique').on(table.taskId, table.repository),
  uniqueIndex('task_work_units_repository_branch_unique').on(table.repository, table.branch),
  uniqueIndex('task_work_units_workspace_path_unique').on(table.workspacePath),
  uniqueIndex('task_work_units_repository_pull_request_unique').on(table.repository, table.pullRequestNumber),
]);

export const taskAttempts = pgTable('task_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  stage: taskStateEnum('stage').notNull(),
  attempt: integer('attempt').notNull(),
  failureCategory: text('failure_category'),
  /** Normalized stage input: prompt digest, template version, model selection, and workspace commits. Never a prompt or secret. */
  input: jsonb('input').$type<Record<string, unknown>>(),
  /** Normalized, schema-validated model result or deterministic stage result. */
  result: jsonb('result').$type<Record<string, unknown>>(),
  /** Redacted validation evidence such as quality command outcomes and diff-policy findings. */
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  /** Runner token usage for the attempt. */
  usage: jsonb('usage').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('task_attempts_task_stage_attempt_unique').on(table.taskId, table.stage, table.attempt),
]);

export const taskCheckpoints = pgTable('task_checkpoints', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  stage: taskStateEnum('stage').notNull(),
  checkpointKey: text('checkpoint_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('task_checkpoints_task_checkpoint_key_unique').on(table.taskId, table.checkpointKey),
]);

export const externalOperations = pgTable('external_operations', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  operationType: text('operation_type').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').notNull().default('PENDING'),
  request: jsonb('request').$type<Record<string, unknown>>().notNull().default({}),
  response: jsonb('response').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const intakeQuarantines = pgTable('intake_quarantines', {
  id: uuid('id').defaultRandom().primaryKey(),
  linearIssueId: text('linear_issue_id').notNull().unique(),
  linearIdentifier: text('linear_identifier').notNull(),
  reason: text('reason').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orchestratorControls = pgTable('orchestrator_controls', {
  id: text('id').primaryKey(),
  pauseNewWork: boolean('pause_new_work').notNull().default(false),
  scheduleOverride: text('schedule_override').$type<'normal' | 'enabled' | 'disabled'>().notNull().default('normal'),
  /** Stops all stage execution and maintenance on every worker until released; read-only intake continues. */
  killSwitch: boolean('kill_switch').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operatorActions = pgTable('operator_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  action: text('action').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  taskId: uuid('task_id').references(() => tasks.id),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('operator_actions_task_id_idx').on(table.taskId),
]);
