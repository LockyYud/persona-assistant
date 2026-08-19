ALTER TABLE "tasks" ADD COLUMN "notion_page_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "notion_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notion_sync_cursor" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_notion_page_id_idx" ON "tasks" USING btree ("notion_page_id") WHERE "tasks"."notion_page_id" is not null;