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
    type: row.type,
    dueAt: row.dueAt,
    monthlyTargetMinutes: row.monthlyTargetMinutes,
    parentTaskId: row.parentTaskId,
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

  it("keeps a reminder that came due but has not been dispatched yet", async () => {
    const userId = await createTestUser();
    // 10 minutes out, so the early offset (30m before due) already sits in the
    // past — exactly where it lands once a reminder has been created and the
    // clock has moved on past it.
    const dueAt = new Date(Date.now() + 10 * 60 * 1000);
    const row = await insertTask(userId, { dueAt, priority: "medium" });

    // The state between a reminder falling due and the tick claiming it: still
    // active, its moment just passed. runTick syncs Notion — which re-derives
    // for every page it touches — before it claims reminders, so a
    // re-derivation lands in that gap.
    const [pending] = await getTestDb()
      .insert(schema.reminders)
      .values({
        taskId: row.id,
        userId,
        message: "Sắp đến hạn",
        nextRunAt: new Date(Date.now() - 5 * 60 * 1000),
        source: "auto",
        kind: "early",
      })
      .returning();

    await deriveTaskReminders(getTestDb(), toTask(row));

    // Recomputing the offsets cannot bring this one back: its time is behind
    // `now`, so the future-only filter drops it. Deleting it therefore loses
    // the notification outright rather than rescheduling it.
    const survivors = await activeAutoReminders(row.id);
    expect(survivors.map((r) => r.id)).toContain(pending!.id);
  });

  it("survives a dueAt pushed later while an owed reminder is still around", async () => {
    const userId = await createTestUser();
    const row = await insertTask(userId, {
      dueAt: new Date(Date.now() + 10 * 60 * 1000),
      priority: "medium",
    });
    await getTestDb()
      .insert(schema.reminders)
      .values({
        taskId: row.id,
        userId,
        message: "Sắp đến hạn",
        nextRunAt: new Date(Date.now() - 5 * 60 * 1000),
        source: "auto",
        kind: "early",
      });

    // Moving the deadline out makes the recomputed "early" future again, so a
    // fresh row is inserted while the owed one is still active — and the
    // unique index is scoped to exactly (task, kind, active).
    const moved = { ...toTask(row), dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000) };

    await expect(deriveTaskReminders(getTestDb(), moved)).resolves.toBeUndefined();
  });

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

describe("routines get no deadline reminders at all", () => {
  beforeEach(resetTestDb);

  it("derives nothing for a routine, even one carrying a dueAt", async () => {
    const userId = await createTestUser();
    const row = await insertTask(userId, {
      title: "Đạt aim IELTS",
      monthlyTargetMinutes: 20 * 60,
      dueAt: new Date(Date.now() + 60 * 86_400_000),
    });

    await deriveTaskReminders(getTestDb(), toTask(row));

    const kinds = (
      await getTestDb()
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.taskId, row.id))
    ).map((reminder) => reminder.kind);

    // A routine sits in no dated bucket, so a deadline on one is invisible
    // everywhere the user looks. Reminding them about it over Telegram would
    // be the single place it ever appeared, contradicting every screen.
    expect(kinds).toEqual([]);
  });

  it("still derives overdue for an ordinary task", async () => {
    const userId = await createTestUser();
    const row = await insertTask(userId, {
      title: "Ship the release",
      dueAt: new Date(Date.now() + 60 * 86_400_000),
    });

    await deriveTaskReminders(getTestDb(), toTask(row));

    const kinds = (
      await getTestDb()
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.taskId, row.id))
    ).map((reminder) => reminder.kind);

    expect(kinds).toContain("overdue");
  });
});
