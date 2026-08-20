CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"channel" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_channel_updated_idx" ON "conversations" USING btree ("user_id","channel","updated_at");--> statement-breakpoint
--> Hand-written backfill (drizzle-kit cannot infer it).
--> Until now conversation_id was a bare grouping key with no parent row, so
--> every existing thread needs one before the foreign key below can be added
--> — otherwise this migration fails on any database with chat history.
--> Timestamps come from the messages themselves so the thread list orders
--> correctly, and the title is seeded from the opening user message.
INSERT INTO "conversations" ("id", "user_id", "title", "channel", "created_at", "updated_at")
SELECT
	spans."conversation_id",
	opening."user_id",
	NULLIF(LEFT(COALESCE(opening."content", ''), 60), ''),
	'web',
	spans."first_at",
	spans."last_at"
FROM (
	SELECT "conversation_id", MIN("created_at") AS "first_at", MAX("created_at") AS "last_at"
	FROM "conversation_messages"
	GROUP BY "conversation_id"
) AS spans
JOIN LATERAL (
	SELECT "user_id", "content"
	FROM "conversation_messages"
	WHERE "conversation_id" = spans."conversation_id"
	ORDER BY ("role" = 'user') DESC, "created_at"
	LIMIT 1
) AS opening ON TRUE
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
