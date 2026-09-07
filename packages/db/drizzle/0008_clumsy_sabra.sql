CREATE TABLE IF NOT EXISTS "work_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_at" timestamp with time zone,
	"planned_minutes" integer NOT NULL,
	"actual_minutes" integer,
	"status" text DEFAULT 'planned' NOT NULL,
	"notion_page_id" text,
	"notion_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "monthly_target_minutes" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_sessions_task_date_idx" ON "work_sessions" USING btree ("task_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_sessions_user_date_idx" ON "work_sessions" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_sessions_notion_page_id_idx" ON "work_sessions" USING btree ("notion_page_id") WHERE "work_sessions"."notion_page_id" is not null;