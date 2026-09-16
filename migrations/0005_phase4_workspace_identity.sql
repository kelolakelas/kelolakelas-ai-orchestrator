ALTER TABLE "task_work_units" ADD COLUMN "workspace_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "workspace_cleanup_blocked_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_work_units_repository_branch_unique" ON "task_work_units" USING btree ("repository","branch");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_work_units_workspace_path_unique" ON "task_work_units" USING btree ("workspace_path");