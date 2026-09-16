ALTER TYPE "public"."task_state" ADD VALUE 'CANCELLED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"task_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orchestrator_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"pause_new_work" boolean DEFAULT false NOT NULL,
	"schedule_override" text DEFAULT 'normal' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resume_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operator_actions" ADD CONSTRAINT "operator_actions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_actions_task_id_idx" ON "operator_actions" USING btree ("task_id");--> statement-breakpoint
INSERT INTO "orchestrator_controls" ("id") VALUES ('global') ON CONFLICT ("id") DO NOTHING;
