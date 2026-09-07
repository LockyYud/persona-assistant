import { schema } from "@persona/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { localMonth } from "./local-time.js";
import { DrizzleTaskService } from "./task-service.js";

/** 20 hours a month — the target this design was worked through with. */
const MONTHLY_TARGET = 20 * 60;

function makeService() {
  return new DrizzleTaskService(getTestDb());
}

/**
 * A day inside the user's current month, so the session lands in the window
 * pace is computed over. Clamped to the month's length, since `offset` days
 * past the 1st can overshoot February.
 */
function dateInThisMonth(offset = 0): string {
  const month = localMonth(new Date(), "Asia/Bangkok");
  const day = Math.min(1 + offset, month.daysInMonth);
  return `${month.key}-${String(day).padStart(2, "0")}`;
}

async function insertSession(
  userId: string,
  taskId: string,
  values: Partial<typeof schema.workSessions.$inferInsert> = {},
) {
  const [row] = await getTestDb()
    .insert(schema.workSessions)
    .values({
      userId,
      taskId,
      date: dateInThisMonth(),
      plannedMinutes: 60,
      ...values,
    })
    .returning();
  if (!row) throw new Error("failed to insert session");
  return row;
}

async function createRoutine(userId: string, title = "Học tiếng Anh") {
  const service = makeService();
  const task = await service.createTask(userId, {
    title,
    priority: "medium",
    type: "personal",
    monthlyTargetMinutes: MONTHLY_TARGET,
  });
  // A routine's normal state is in_progress; "open" is how one is paused.
  return service.updateTask(userId, { taskId: task.id, status: "in_progress" });
}

describe("routine tasks and pace", () => {
  beforeEach(resetTestDb);

  it("reports no pace for an ordinary task, rather than a zeroed one", async () => {
    const userId = await createTestUser();
    const service = makeService();
    await service.createTask(userId, { title: "Ship release", priority: "high", type: "work" });

    const [task] = await service.listTasks(userId, {});

    // Same distinction progress draws: "not a routine" is not "a routine with
    // nothing done".
    expect(task?.monthlyTargetMinutes).toBeNull();
    expect(task?.pace).toBeNull();
  });

  it("buckets an active routine as ongoing, never as unscheduled", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);

    const now = await makeService().listNowTasks(userId);

    // The whole point of the bucket: a routine has no dueAt, so without it
    // the tasks worked on most consistently would pile up in the "not
    // scheduled yet" list forever.
    expect(now.ongoing.map((task) => task.id)).toEqual([routine.id]);
    expect(now.unscheduled).toEqual([]);
    expect(now.unscheduledCount).toBe(0);
    expect(now.ongoing[0]?.pace?.targetMinutes).toBe(MONTHLY_TARGET);
  });

  it("drops a paused routine out of every bucket", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    await makeService().updateTask(userId, { taskId: routine.id, status: "open" });

    const now = await makeService().listNowTasks(userId);

    // Flipping to "open" is the pause mechanism — it must not reappear in
    // `unscheduled`, which is what would happen if only `ongoing` filtered on
    // status.
    expect(now.ongoing).toEqual([]);
    expect(now.unscheduled).toEqual([]);
    expect(now.overdue).toEqual([]);
    expect(now.today).toEqual([]);
    expect(now.future).toEqual([]);
  });

  it("keeps a routine out of the dueAt buckets even when it has a deadline", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId, "Đạt aim IELTS");
    const service = makeService();
    await service.updateTask(userId, {
      taskId: routine.id,
      dueAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    });

    const now = await service.listNowTasks(userId);

    // One line, not two: the deadline still rides on the row and still drives
    // the task's reminders, neither of which the bucketing touches.
    expect(now.ongoing.map((task) => task.id)).toEqual([routine.id]);
    expect(now.future).toEqual([]);
    expect(now.ongoing[0]?.dueAt).not.toBeNull();
  });

  it("never reports a routine as overdue, however long its deadline has passed", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId, "Đạt aim IELTS");
    const service = makeService();
    await service.updateTask(userId, {
      taskId: routine.id,
      dueAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const now = await service.listNowTasks(userId);

    // A routine is pursued at a rate, so there is nothing for a date to be
    // late against. The only thing that ends one is the user cancelling it.
    expect(now.overdue).toEqual([]);
    expect(now.ongoing.map((task) => task.id)).toEqual([routine.id]);
  });

  it("credits completed sessions, falling back to the minutes committed to", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    // Ticked off with no actual recorded -> credits plannedMinutes.
    await insertSession(userId, routine.id, {
      date: dateInThisMonth(0),
      plannedMinutes: 60,
      status: "done",
    });
    // Recorded honestly as a short session.
    await insertSession(userId, routine.id, {
      date: dateInThisMonth(1),
      plannedMinutes: 60,
      actualMinutes: 20,
      status: "done",
    });

    const now = await makeService().listNowTasks(userId);

    expect(now.ongoing[0]?.pace?.spentMinutes).toBe(80);
  });

  it("counts neither a session still planned nor one skipped", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    await insertSession(userId, routine.id, {
      date: dateInThisMonth(0),
      plannedMinutes: 90,
      status: "planned",
    });
    await insertSession(userId, routine.id, {
      date: dateInThisMonth(1),
      plannedMinutes: 90,
      status: "skipped",
    });

    const now = await makeService().listNowTasks(userId);

    // A planned session is an intention: counting it would hide the exact
    // failure pace exists to catch. A skipped one is a deliberate pass.
    expect(now.ongoing[0]?.pace?.spentMinutes).toBe(0);
  });

  it("ignores sessions from another month", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    await insertSession(userId, routine.id, {
      date: "2020-01-15",
      plannedMinutes: 600,
      status: "done",
    });

    const now = await makeService().listNowTasks(userId);

    expect(now.ongoing[0]?.pace?.spentMinutes).toBe(0);
  });

  it("does not credit another task's sessions", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    const other = await createRoutine(userId, "Gym");
    await insertSession(userId, other.id, { plannedMinutes: 120, status: "done" });

    const now = await makeService().listNowTasks(userId);
    const byId = new Map(now.ongoing.map((task) => [task.id, task]));

    expect(byId.get(routine.id)?.pace?.spentMinutes).toBe(0);
    expect(byId.get(other.id)?.pace?.spentMinutes).toBe(120);
  });

  it("orders ongoing routines furthest-behind first", async () => {
    const userId = await createTestUser();
    const behind = await createRoutine(userId, "Behind");
    const ahead = await createRoutine(userId, "Ahead");
    await insertSession(userId, ahead.id, { plannedMinutes: MONTHLY_TARGET, status: "done" });

    const now = await makeService().listNowTasks(userId);

    expect(now.ongoing.map((task) => task.id)).toEqual([behind.id, ahead.id]);
  });

  it("stops treating a task as a routine once its target is cleared", async () => {
    const userId = await createTestUser();
    const routine = await createRoutine(userId);
    const service = makeService();
    await insertSession(userId, routine.id, { plannedMinutes: 60, status: "done" });

    await service.updateTask(userId, { taskId: routine.id, monthlyTargetMinutes: null });
    const now = await service.listNowTasks(userId);

    expect(now.ongoing).toEqual([]);
    // Its history is untouched — clearing the target is not deleting the work.
    const sessions = await getTestDb().select().from(schema.workSessions);
    expect(sessions).toHaveLength(1);
  });
});
