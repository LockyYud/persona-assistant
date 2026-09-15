ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notion_sessions_sync_cursor" timestamp with time zone;
