CREATE TYPE "public"."task_state" AS ENUM('QUEUED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING', 'PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW', 'PAUSED_SCHEDULE', 'PAUSED_LIMIT', 'BLOCKED', 'FAILED', 'COMPLETED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"from_state" "task_state",
	"to_state" "task_state" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"linear_issue_id" text NOT NULL,
	"linear_identifier" text NOT NULL,
	"repository" text,
	"workspace_path" text,
	"branch" text,
	"state" "task_state" DEFAULT 'QUEUED' NOT NULL,
	"resume_state" "task_state",
	"complexity" text,
	"risk" text,
	"selected_model_tier" text,
	"selected_model" text,
	"reasoning_effort" text,
	"implementation_attempts" integer DEFAULT 0 NOT NULL,
	"quality_fix_attempts" integer DEFAULT 0 NOT NULL,
	"review_attempts" integer DEFAULT 0 NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_linear_issue_id_unique" UNIQUE("linear_issue_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
