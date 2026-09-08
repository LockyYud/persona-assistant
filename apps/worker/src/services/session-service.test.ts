import { eq } from "drizzle-orm";
import { schema } from "@persona/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { dateKeyInTimezone } from "./local-time.js";
import { DrizzleSessionService } from "./session-service.js";
import { DrizzleTaskService } from "./task-service.js";

function makeServices() {
  const db = getTestDb();
  return { sessions: new DrizzleSessionService(db), tasks: new DrizzleTaskService(db) };
}

async function createTask(userId: string, title = "Học tiếng Anh") {
  const { tasks } = makeServices();
  return tasks.createTask(userId, {
    title,
    priority: "medium",
    type: "personal",
    monthlyTargetMinutes: 20 * 60,
  });
}

describe("DrizzleSessionService", () => {
  beforeEach(resetTestDb);

  it("plans a day on an ordinary task, not only on a routine", async () => {
    // The desktop panel offers today's minutes on every block, so a session
    // must not require a monthly target. Such a session records time spent
    // and contributes to no pace, which is the whole of the difference.
    const userId = await createTestUser();
    const { tasks, sessions } = makeServices();
    const plain = await tasks.createTask(userId, {
      title: "Ship the release",
      priority: "high",
      type: "work",
    });

    const session = await sessions.planSession(userId, {
      taskId: plain.id,
      plannedMinutes: 45,
    });

    expect(session.taskId).toBe(plain.id);
    expect(plain.monthlyTargetMinutes).toBeNull();

    const done = await sessions.completeSession(userId, { sessionId: session.id });
    expect(done.actualMinutes).toBe(45);

    // It shows up in the day's list like any other, so the widget can render
    // it under the task it belongs to.
    const today = await sessions.listSessionsForDate(userId, session.date);
    expect(today.map((entry) => entry.task.id)).toEqual([plain.id]);
  });

  it("defaults the day to the user's own today, not the host's", async () => {
    // Kiritimati is UTC+14: for a good part of every UTC day the two disagree
    // about the date, which is the whole reason the column stores a local day.
    const userId = await createTestUser("Pacific/Kiritimati");
    const task = await createTask(userId);
    const { sessions } = makeServices();

    const session = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });

    expect(session.date).toBe(dateKeyInTimezone(new Date(), "Pacific/Kiritimati"));
  });

  it("revises the existing session instead of failing on a second plan", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();

    const first = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });
    const second = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 90,
    });

    // One session per task per day, so a second plan has to mean "actually,
    // make it 90 minutes".
    expect(second.id).toBe(first.id);
    expect(second.plannedMinutes).toBe(90);
    const all = await sessions.listSessions(userId, { taskId: task.id });
    expect(all).toHaveLength(1);
  });

  it("revives a day it had been told to skip", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });
    await sessions.skipSession(userId, { sessionId: planned.id });

    const revised = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });

    expect(revised.status).toBe("planned");
  });

  it("leaves finished work finished when the commitment is revised", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });
    await sessions.completeSession(userId, { sessionId: planned.id, actualMinutes: 45 });

    const revised = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 90,
    });

    // Changing what was committed to is not un-doing work that happened.
    expect(revised.status).toBe("done");
    expect(revised.actualMinutes).toBe(45);
  });

  it("keeps an existing start time when the revision omits one", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
      startAt: "2026-09-07T12:00:00.000Z",
    });

    const revised = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 90,
    });

    // Adjusting the length must not silently strip the time it was set for.
    expect(revised.startAt).toEqual(planned.startAt);
  });

  it("credits the minutes committed to when none are recorded", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });

    const done = await sessions.completeSession(userId, { sessionId: planned.id });

    // Ticking a session off is the common case and must not require typing a
    // number.
    expect(done.status).toBe("done");
    expect(done.actualMinutes).toBe(60);
  });

  it("records a short session honestly when minutes are given", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });

    const done = await sessions.completeSession(userId, {
      sessionId: planned.id,
      actualMinutes: 20,
    });

    expect(done.actualMinutes).toBe(20);
  });

  it("clears recorded minutes when a session is skipped after the fact", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });
    await sessions.completeSession(userId, { sessionId: planned.id, actualMinutes: 30 });

    const skipped = await sessions.skipSession(userId, { sessionId: planned.id });

    // A skipped session is one that did not happen; leaving 30 minutes on it
    // would keep crediting time to the month.
    expect(skipped.status).toBe("skipped");
    expect(skipped.actualMinutes).toBeNull();
  });

  it("refuses to plan against a task belonging to someone else", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const task = await createTask(owner);
    const { sessions } = makeServices();

    await expect(
      sessions.planSession(stranger, { taskId: task.id, plannedMinutes: 60 }),
    ).rejects.toThrow("Task not found");
  });

  it("refuses to complete or skip someone else's session", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const task = await createTask(owner);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(owner, { taskId: task.id, plannedMinutes: 60 });

    await expect(
      sessions.completeSession(stranger, { sessionId: planned.id }),
    ).rejects.toThrow("Session not found");
    await expect(sessions.skipSession(stranger, { sessionId: planned.id })).rejects.toThrow(
      "Session not found",
    );
  });

  it("lists a day's sessions with timed ones first, in clock order", async () => {
    const userId = await createTestUser();
    const morning = await createTask(userId, "Morning");
    const evening = await createTask(userId, "Evening");
    const untimed = await createTask(userId, "Untimed");
    const { sessions } = makeServices();

    await sessions.planSession(userId, {
      taskId: untimed.id,
      date: "2026-09-07",
      plannedMinutes: 30,
    });
    await sessions.planSession(userId, {
      taskId: evening.id,
      date: "2026-09-07",
      plannedMinutes: 60,
      startAt: "2026-09-07T12:00:00.000Z",
    });
    await sessions.planSession(userId, {
      taskId: morning.id,
      date: "2026-09-07",
      plannedMinutes: 60,
      startAt: "2026-09-07T01:00:00.000Z",
    });

    const today = await sessions.listSessionsForDate(userId, "2026-09-07");

    expect(today.map((s) => s.task.title)).toEqual(["Morning", "Evening", "Untimed"]);
  });

  it("scopes a day's list to the owner and the day asked for", async () => {
    const userId = await createTestUser();
    const stranger = await createTestUser();
    const mine = await createTask(userId);
    const theirs = await createTask(stranger, "Their task");
    const { sessions } = makeServices();

    await sessions.planSession(userId, { taskId: mine.id, date: "2026-09-07", plannedMinutes: 60 });
    await sessions.planSession(userId, { taskId: mine.id, date: "2026-09-08", plannedMinutes: 60 });
    await sessions.planSession(stranger, {
      taskId: theirs.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });

    const today = await sessions.listSessionsForDate(userId, "2026-09-07");

    expect(today).toHaveLength(1);
    expect(today[0]?.taskId).toBe(mine.id);
  });

  it("goes away with the task it belonged to", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });

    await getTestDb().delete(schema.tasks).where(eq(schema.tasks.id, task.id));

    expect(await sessions.listSessions(userId, {})).toEqual([]);
  });
});
