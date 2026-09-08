import { and, eq, gt } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { ReminderKind, Task } from "@persona/core";

// Accepts either a top-level Database or a transaction handle from
// db.transaction(async (tx) => ...) — callers always run this inside the
// same transaction as the task write it derives from.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbOrTx = Database | Tx;

const MINUTE = 60_000;
const EARLY_MINUTES = 30;
const URGENT_EARLY_MINUTES = 120;
const OVERDUE_MINUTES = 30;

function reminderMessage(kind: ReminderKind, task: Task): string {
  switch (kind) {
    case "urgent_early":
    case "early":
      return `Sắp đến hạn: ${task.title}`;
    case "due":
      return `Đến hạn: ${task.title}`;
    case "overdue":
      return `Quá hạn: ${task.title}`;
  }
}

function candidateOffsets(task: Task): Array<{ kind: ReminderKind; minutesBeforeDue: number }> {
  // A routine is pursued at a rate, not finished by a date. The Now view keeps
  // one out of every dated bucket, so a deadline it happens to carry shows on
  // no screen at all — which leaves a Telegram message the only place it can
  // surface, contradicting everything the user can see. Its daily session
  // reminders are unaffected: those are `manual` reminders with a null kind,
  // which this function never produces and deriveTaskReminders never deletes.
  if (task.monthlyTargetMinutes !== null) return [];

  const offsets: Array<{ kind: ReminderKind; minutesBeforeDue: number }> = [
    { kind: "early", minutesBeforeDue: EARLY_MINUTES },
    { kind: "due", minutesBeforeDue: 0 },
    { kind: "overdue", minutesBeforeDue: -OVERDUE_MINUTES },
  ];

  if (task.priority === "urgent") {
    offsets.unshift({ kind: "urgent_early", minutesBeforeDue: URGENT_EARLY_MINUTES });
  }

  return offsets;
}

/**
 * Re-derives the "auto" reminders (early/due/overdue, plus an extra early one
 * for urgent tasks) for a task from its current dueAt/priority. Called
 * whenever a task is created or updated, inside the same transaction as that
 * write.
 *
 * Only ever deletes reminders with status="active" — the scheduler
 * (scheduler/tick.ts) flips a one-shot reminder to "completed" in the same
 * transaction that creates its trigger_run, so an "active" auto reminder can
 * never yet have a trigger_run/outbox/notification_deliveries row pointing
 * at it. That's what makes a wholesale delete-and-reinsert here safe: it can
 * only ever remove reminders that haven't fired, never the audit trail of
 * ones that have. Fired reminders are left in place forever; if the same
 * (task, kind) needs a fresh occurrence later, a new row is inserted instead
 * — the unique index is scoped to status="active" specifically so that can
 * coexist with the old "completed" row.
 */
export async function deriveTaskReminders(db: DbOrTx, task: Task): Promise<void> {
  // Only reminders still ahead of us are rebuilt. One that has already come
  // due but has not been dispatched yet is owed, and deleting it loses the
  // notification outright rather than rescheduling it: the offsets are
  // recomputed from dueAt, so a moment now behind `now` fails the future-only
  // filter below and never comes back. The gap is not hypothetical — runTick
  // syncs Notion, which re-derives every page it touches, before it claims
  // due reminders, and it does that every minute.
  await db
    .delete(schema.reminders)
    .where(
      and(
        eq(schema.reminders.taskId, task.id),
        eq(schema.reminders.source, "auto"),
        eq(schema.reminders.status, "active"),
        gt(schema.reminders.nextRunAt, new Date()),
      ),
    );

  if (!task.dueAt || task.status === "done" || task.status === "cancelled") return;

  const due = task.dueAt.getTime();
  const now = Date.now();

  const rows = candidateOffsets(task)
    .map((candidate) => ({
      kind: candidate.kind,
      at: due - candidate.minutesBeforeDue * MINUTE,
    }))
    .filter((candidate) => candidate.at > now)
    .map((candidate) => ({
      taskId: task.id,
      userId: task.userId,
      message: reminderMessage(candidate.kind, task),
      timezone: "Asia/Bangkok",
      nextRunAt: new Date(candidate.at),
      source: "auto" as const,
      kind: candidate.kind,
    }));

  if (rows.length > 0) {
    // An owed reminder kept above can collide with a rebuilt one of the same
    // kind when dueAt moves later. Skipping the insert keeps the row that is
    // about to fire rather than throwing inside the caller's transaction —
    // the sync applies a whole Notion page in one, and a unique violation
    // here would take that page's update down with it.
    await db.insert(schema.reminders).values(rows).onConflictDoNothing();
  }
}

/**
 * Cancels any still-active (not-yet-fired) auto reminders for a task — used
 * on completion. Fired reminders (status="completed") are never touched,
 * same reasoning as deriveTaskReminders above.
 */
export async function cancelAutoReminders(db: DbOrTx, taskId: string): Promise<void> {
  await db
    .update(schema.reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(schema.reminders.taskId, taskId),
        eq(schema.reminders.source, "auto"),
        eq(schema.reminders.status, "active"),
      ),
    );
}
