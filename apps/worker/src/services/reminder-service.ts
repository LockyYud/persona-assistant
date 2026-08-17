import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { CreateReminderInput, Reminder, ReminderService } from "@persona/core";

function toDomainReminder(row: typeof schema.reminders.$inferSelect): Reminder {
  return {
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    message: row.message,
    timezone: row.timezone,
    rrule: row.rrule,
    nextRunAt: row.nextRunAt,
    status: row.status,
    source: row.source,
    kind: row.kind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleReminderService implements ReminderService {
  constructor(private readonly db: Database) {}

  async createReminder(userId: string, input: CreateReminderInput): Promise<Reminder> {
    const [row] = await this.db
      .insert(schema.reminders)
      .values({
        taskId: input.taskId,
        userId,
        message: input.message,
        timezone: input.timezone,
        rrule: input.rrule ?? null,
        nextRunAt: new Date(input.nextRunAt),
      })
      .returning();

    if (!row) throw new Error("Failed to create reminder");
    return toDomainReminder(row);
  }

  async cancelReminder(userId: string, reminderId: string): Promise<void> {
    await this.db
      .update(schema.reminders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(schema.reminders.id, reminderId), eq(schema.reminders.userId, userId)));
  }
}
