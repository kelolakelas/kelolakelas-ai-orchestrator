import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { complexityValues } from '../intake/planning-contract.js';

const persistedTaskStates = [
  'QUEUED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING',
  'PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW', 'PAUSED_SCHEDULE', 'PAUSED_LIMIT',
  'BLOCKED', 'FAILED', 'COMPLETED',
] as const;

export const taskStateEnum = pgEnum('task_state', [...persistedTaskStates]);
export const taskComplexityEnum = pgEnum('task_complexity', [...complexityValues]);

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  linearIssueId: text('linear_issue_id').notNull().unique(),
  linearIdentifier: text('linear_identifier').notNull(),
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
});
