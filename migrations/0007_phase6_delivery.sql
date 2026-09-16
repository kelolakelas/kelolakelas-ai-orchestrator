ALTER TABLE "task_work_units" ADD COLUMN "pushed_commit" text;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "pull_request_number" integer;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "merge_commit" text;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "delivery_observation" jsonb;--> statement-breakpoint
ALTER TABLE "task_work_units" ADD COLUMN "delivery_observed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_work_units_repository_pull_request_unique" ON "task_work_units" USING btree ("repository","pull_request_number");