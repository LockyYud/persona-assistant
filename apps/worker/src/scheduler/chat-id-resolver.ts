import { eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";

export function makeChatIdResolver(db: Database) {
  return async (triggerRunId: string): Promise<string | null> => {
    const [row] = await db
      .select({ telegramChatId: schema.users.telegramChatId })
      .from(schema.triggerRuns)
      .innerJoin(schema.reminders, eq(schema.triggerRuns.reminderId, schema.reminders.id))
      .innerJoin(schema.users, eq(schema.reminders.userId, schema.users.id))
      .where(eq(schema.triggerRuns.id, triggerRunId));

    return row?.telegramChatId ?? null;
  };
}
