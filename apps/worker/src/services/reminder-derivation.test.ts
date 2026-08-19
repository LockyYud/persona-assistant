import { eq } from "drizzle-orm";
import { schema } from "@persona/db";
import type { Task } from "@persona/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { cancelAutoReminders, deriveTaskReminders } from "./reminder-derivation.js";

async function insertTask(userId: string, overrides: Partial<typeof schema.tasks.$inferInsert> = {}) {
  const db = getTestDb();
  const [row] = await db
    .insert(schema.tasks)
    .values({ userId, title: "Test task", ...overrides })
    .returning();
  if (!row) throw new Error("failed to insert task");
  return row;
}

function toTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt,
    notionPageId: row.notionPageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function activeAutoReminders(taskId: string) {
  const db = getTestDb();
  return db
    .select()
    .from(schema.reminders)
    .where(eq(schema.reminders.taskId, taskId))
    .then((rows) => rows.filter((r) => r.source === "auto"));
}

describe("deriveTaskReminders", () => {
  beforeEach(resetTestDb);

  it("derives early/due/overdue for a normal-priority task with a future dueAt", async () => {
    const userId = await createTestUser();
    const dueAt = new Date(Date.now() + 5 * 60 * 60 * 1000); // 5h out — clears all offsets
    const row = await insertTask(userId, { dueAt, priority: "medium" });

    await deriveTaskReminders(getTestDb(), toTask(row));

    const reminders = await activeAutoReminders(row.id);
    const kinds = reminders.map((r) => r.kind).sort();
    expect(kinds).toEqual(["due", "early", "overdue"]);
    expect(reminders.every((r) => r.status === "active")).toBe(true);
  });

  it("adds an extra urgent_early reminder for urgent-priority tasks", async () => {
    const userId = await createTestUser();
    const dueAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const row = await insertTask(userId, { dueAt, priority: "urgent" });

    await deriveTaskReminders(getTestDb(), toTask(row));

    const reminders = await activeAutoReminders(row.id);
    const kinds = reminders.map((r) => r.kind).sort();
    expect(kinds).toEqual(["due", "early", "overdue", "urgent_early"]);
  });

  it("derives nothing for a task with no dueAt, or one that's done/cancelled", async () => {
    const userId = await createTestUser();
    const noDue = await insertTask(userId, { dueAt: null });
    await deriveTaskReminders(getTestDb(), toTask(noDue));
    expect(await activeAutoReminders(noDue.id)).toHaveLength(0);

    const done = await insertTask(userId, {
      dueAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "done",
    });
    await deriveTaskReminders(getTestDb(), toTask(done));
    expect(await activeAutoReminders(done.id)).toHaveLength(0);
  });

  it("never deletes a reminder that has already fired, and its trigger_run/outbox/notification_delivery audit trail survives a re-derive", async () => {
    const userId = await createTestUser();
    const dueAt = new Date(Date.now() + 60 * 60 * 1000); // still in the future after the edit below
    const row = await insertTask(userId, { dueAt, priority: "medium" });
    const db = getTestDb();

    // Simulate the scheduler having already fired the "due" reminder: a
    // completed reminder row with a full trigger_run -> outbox ->
    // notification_deliveries chain hanging off it (mirrors what
    // scheduler/tick.ts actually produces).
    const [firedReminder] = await db
      .insert(schema.reminders)
      .values({
        taskId: row.id,
        userId,
        message: "Đến hạn: Test task",
        nextRunAt: new Date(Date.now() - 60 * 60 * 1000),
        status: "completed",
        source: "auto",
        kind: "due",
      })
      .returning();
    if (!firedReminder) throw new Error("setup failed");

    const [triggerRun] = await db
      .insert(schema.triggerRuns)
      .values({
        reminderId: firedReminder.id,
        idempotencyKey: `${firedReminder.id}:${firedReminder.nextRunAt.toISOString()}`,
        scheduledFor: firedReminder.nextRunAt,
        status: "completed",
      })
      .returning();
    if (!triggerRun) throw new Error("setup failed");

    const [outboxRow] = await db
      .insert(schema.outbox)
      .values({
        triggerRunId: triggerRun.id,
        channel: "telegram",
        payload: { reminderId: firedReminder.id, message: firedReminder.message },
        status: "sent",
      })
      .returning();
    if (!outboxRow) throw new Error("setup failed");

    await db.insert(schema.notificationDeliveries).values({
      triggerRunId: triggerRun.id,
      channel: "telegram",
      status: "sent",
      providerMessageId: "123",
    });

    // The user edits the task (e.g. renames it) after the reminder fired —
    // this is exactly the createTask/updateTask call path.
    await deriveTaskReminders(db, toTask(row));

    // The fired reminder and its whole audit trail must be untouched.
    const [stillThere] = await db
      .select()
      .from(schema.reminders)
      .where(eq(schema.reminders.id, firedReminder.id));
    expect(stillThere?.status).toBe("completed");

    const [triggerRunStillThere] = await db
      .select()
      .from(schema.triggerRuns)
      .where(eq(schema.triggerRuns.id, triggerRun.id));
    expect(triggerRunStillThere).toBeDefined();

    const [outboxStillThere] = await db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.id, outboxRow.id));
    expect(outboxStillThere).toBeDefined();

    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.triggerRunId, triggerRun.id));
    expect(deliveries).toHaveLength(1);

    // And a fresh "due" reminder for the same task must have been inserted
    // without a unique-constraint conflict with the completed one.
    const reminders = await activeAutoReminders(row.id);
    expect(reminders.some((r) => r.kind === "due")).toBe(true);
  });
});

describe("cancelAutoReminders", () => {
  beforeEach(resetTestDb);

  it("cancels active auto reminders but leaves already-fired ones alone", async () => {
    const userId = await createTestUser();
    const row = await insertTask(userId, { dueAt: new Date(Date.now() + 60 * 60 * 1000) });
    const db = getTestDb();

    const [active] = await db
      .insert(schema.reminders)
      .values({
        taskId: row.id,
        userId,
        message: "early",
        nextRunAt: new Date(Date.now() + 30 * 60 * 1000),
        status: "active",
        source: "auto",
        kind: "early",
      })
      .returning();
    const [fired] = await db
      .insert(schema.reminders)
      .values({
        taskId: row.id,
        userId,
        message: "due",
        nextRunAt: new Date(Date.now() - 60 * 60 * 1000),
        status: "completed",
        source: "auto",
        kind: "due",
      })
      .returning();
    if (!active || !fired) throw new Error("setup failed");

    await cancelAutoReminders(db, row.id);

    const [activeAfter] = await db.select().from(schema.reminders).where(eq(schema.reminders.id, active.id));
    const [firedAfter] = await db.select().from(schema.reminders).where(eq(schema.reminders.id, fired.id));

    expect(activeAfter?.status).toBe("cancelled");
    expect(firedAfter?.status).toBe("completed");
  });
});
