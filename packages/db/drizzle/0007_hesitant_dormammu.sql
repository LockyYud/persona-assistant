ALTER TABLE "users" ADD COLUMN "briefing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "briefing_hour" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "briefing_minute" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_briefing_on" date;