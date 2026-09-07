import { and, eq } from "drizzle-orm";
import { schema } from "@persona/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleSessionService } from "./session-service.js";
import { DrizzleTaskService } from "./task-service.js";

const HOUR = 3_600_000;

function makeServices() {
  const db = getTestDb();
  return { sessions: new DrizzleSessionService(db), tasks: new DrizzleTaskService(db) };
}

async function createRoutine(userId: string) {
  const { tasks } = makeServices();
  const task = await tasks.createTask(userId, {
    title: "Học tiếng Anh",
    priority: "medium",
    type: "personal",
    monthlyTargetMinutes: 20 * 60,
  });
  return tasks.updateTask(userId, { taskId: task.id, status: "in_progress" });
}

/** Reminders still waiting to fire, which is all these tests care about. */
async function activeReminders(taskId: string) {
  return getTestDb()
    .select()
    .from(schema.reminders)
    .where(and(eq(schema.reminders.taskId, taskId), eq(schema.reminders.status, "active")));
}

describe("session reminders", () => {
  beforeEach(resetTestDb);

  it("gives a timed session exactly one reminder, as a manual one on the parent task", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();
    const startAt = new Date(Date.now() + 3 * HOUR);

    const session = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: startAt.toISOString(),
    });

    const active = await activeReminders(task.id);
    expect(active).toHaveLength(1);
    expect(session.reminderId).toBe(active[0]?.id);
    // "manual" keeps it out of deriveTaskReminders' delete, and a null kind
    // keeps it out of the one-active-per-(task,kind) unique index.
    expect(active[0]?.source).toBe("manual");
    expect(active[0]?.kind).toBeNull();
    expect(active[0]?.nextRunAt).toEqual(startAt);
    expect(active[0]?.message).toContain("Học tiếng Anh");
  });

  it("gives an untimed session none, since there is no hour to fire at", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();

    const session = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });

    expect(session.reminderId).toBeNull();
    expect(await activeReminders(task.id)).toHaveLength(0);
  });

  it("gives none for a start time already gone by", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();

    // Re-planning this morning's session at noon must not fire immediately.
    const session = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: new Date(Date.now() - HOUR).toISOString(),
    });

    expect(session.reminderId).toBeNull();
    expect(await activeReminders(task.id)).toHaveLength(0);
  });

  it("moves the reminder when the session is re-planned, leaving only one waiting", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();
    const first = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });

    const movedTo = new Date(Date.now() + 5 * HOUR);
    const revised = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: movedTo.toISOString(),
    });

    const active = await activeReminders(task.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.nextRunAt).toEqual(movedTo);
    expect(revised.reminderId).not.toBe(first.reminderId);
  });

  it("cancels the reminder when the session is completed", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();
    const session = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    });

    const done = await sessions.completeSession(userId, { sessionId: session.id });

    // Finishing at 18:00 something planned for 19:00 should not still ring.
    expect(done.reminderId).toBeNull();
    expect(await activeReminders(task.id)).toHaveLength(0);
  });

  it("cancels the reminder when the session is skipped", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();
    const session = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    });

    await sessions.skipSession(userId, { sessionId: session.id });

    expect(await activeReminders(task.id)).toHaveLength(0);
  });

  it("survives an edit to the parent task", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions, tasks } = makeServices();
    const session = await sessions.planSession(userId, {
      taskId: task.id,
      plannedMinutes: 60,
      startAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    });

    // deriveTaskReminders wipes and re-derives on every task write, but only
    // rows with source = "auto" — this asserts that boundary holds.
    await tasks.updateTask(userId, {
      taskId: task.id,
      dueAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    });

    const stillThere = await getTestDb()
      .select()
      .from(schema.reminders)
      .where(eq(schema.reminders.id, session.reminderId!));
    expect(stillThere[0]?.status).toBe("active");
  });

  it("keeps two timed sessions on one task from colliding", async () => {
    const userId = await createTestUser();
    const task = await createRoutine(userId);
    const { sessions } = makeServices();

    await sessions.planSession(userId, {
      taskId: task.id,
      date: "2099-01-01",
      plannedMinutes: 60,
      startAt: "2099-01-01T09:00:00.000Z",
    });
    await sessions.planSession(userId, {
      taskId: task.id,
      date: "2099-01-02",
      plannedMinutes: 60,
      startAt: "2099-01-02T09:00:00.000Z",
    });

    // Two active manual reminders on the same task is only possible because
    // `kind` is null on both — the unique index is scoped to a non-null kind.
    expect(await activeReminders(task.id)).toHaveLength(2);
  });
});
