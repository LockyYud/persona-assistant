import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { WorkSession } from "@persona/core";
import { formatMinutes } from "./pace.js";

// Accepts a transaction handle as well as the pool, matching the shape
// reminder-derivation uses.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbOrTx = Database | Tx;

/**
 * A session's reminder is an ordinary *manual* reminder on the parent task.
 *
 * That is what keeps this change out of the reliability-critical path: nothing
 * in reminders/trigger_runs/outbox needs to know sessions exist, and
 * deriveTaskReminders only ever deletes `source = "auto"` rows, so a task edit
 * cannot sweep one of these away. The session row holds the reminder's id (see
 * work_sessions.reminderId) so it can be found again without a column on
 * `reminders`.
 *
 * Only a session with a start time gets one. A session that is merely "some
 * time today" has nothing to fire at, and the morning briefing already covers
 * it — a reminder at an arbitrary hour would be noise.
 */
function reminderMessage(taskTitle: string, session: WorkSession): string {
  const focus = session.focusText ? `\n${session.focusText}` : "";
  return `Đến giờ: ${taskTitle}${focus} · ${formatMinutes(session.plannedMinutes)}`;
}

/** Marks a session's reminder cancelled, if it has one still waiting to fire. */
export async function cancelSessionReminder(db: DbOrTx, reminderId: string): Promise<void> {
  await db
    .update(schema.reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(schema.reminders.id, reminderId), eq(schema.reminders.status, "active")))
    .execute();
}

/**
 * Brings a session's reminder in line with the session: creates one, moves it,
 * or cancels it.
 *
 * Returns the reminder id to store on the session, or null when it should have
 * none. A start time in the past gets no reminder — re-planning this morning's
 * session at noon should not fire one immediately — and neither does a session
 * already closed out.
 *
 * Rather than update an existing reminder in place, an outdated one is
 * cancelled and a fresh one inserted. A reminder that has already fired is
 * left alone as the audit trail, exactly as the auto-derived ones are, so a
 * "moved" reminder must be a new row anyway.
 */
export async function syncSessionReminder(
  db: DbOrTx,
  session: WorkSession,
  taskTitle: string,
  timezone: string,
): Promise<string | null> {
  if (session.reminderId) await cancelSessionReminder(db, session.reminderId);

  const wanted =
    session.status === "planned" && session.startAt && session.startAt.getTime() > Date.now();
  if (!wanted || !session.startAt) return null;

  const [row] = await db
    .insert(schema.reminders)
    .values({
      taskId: session.taskId,
      userId: session.userId,
      message: reminderMessage(taskTitle, session),
      timezone,
      nextRunAt: session.startAt,
      source: "manual",
      // Null on purpose: `kind` labels the auto-derived early/due/overdue
      // family, and the unique index that keeps one active reminder per
      // (task, kind) only applies where it is set — so several sessions on
      // one task never collide here.
      kind: null,
    })
    .returning({ id: schema.reminders.id });

  return row?.id ?? null;
}
