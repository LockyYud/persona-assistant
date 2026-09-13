DROP INDEX IF EXISTS "work_sessions_task_date_idx";
--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, date ORDER BY start_at NULLS LAST, created_at, id) AS position
  FROM "work_sessions"
)
UPDATE "work_sessions" AS session
SET "position" = ordered.position
FROM ordered
WHERE session.id = ordered.id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_sessions_user_date_position_idx" ON "work_sessions" USING btree ("user_id", "date", "position");
