ALTER TABLE "task_attempts" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "usage" jsonb;