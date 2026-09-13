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

  it("allows multiple executable items on one task/day and revises by session id", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();

    const first = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
    });
    const second = await sessions.planSession(userId, {
      sessionId: first.id,
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 90,
    });

    expect(second.id).toBe(first.id);
    expect(second.plannedMinutes).toBe(90);
    const all = await sessions.listSessions(userId, { taskId: task.id });
    expect(all).toHaveLength(1);
    const additional = await sessions.planSession(userId, { taskId: task.id, date: "2026-09-07", plannedMinutes: 30 });
    expect(additional.id).not.toBe(first.id);
  });

  it("keeps daily focus separate from task structure and lets a revision change it", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId, "RAG Lab");
    const { sessions } = makeServices();

    const first = await sessions.planSession(userId, {
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 60,
      focusText: "Run baseline",
    });
    const revised = await sessions.planSession(userId, {
      sessionId: first.id,
      taskId: task.id,
      date: "2026-09-07",
      plannedMinutes: 90,
      focusText: "Review metrics",
    });

    expect(first.focusText).toBe("Run baseline");
    expect(revised).toMatchObject({ focusText: "Review metrics", plannedMinutes: 90 });
    expect(await makeServices().tasks.listSubtasks(userId, task.id)).toEqual([]);
  });

  it("plans a confirmed Today batch atomically for ordinary tasks and routines", async () => {
    const userId = await createTestUser();
    const { tasks, sessions } = makeServices();
    const ordinary = await tasks.createTask(userId, { title: "RAG Lab", priority: "high", type: "work" });
    const routine = await createTask(userId, "English");

    const planned = await sessions.setTodayPlan(userId, {
      items: [
        { taskId: ordinary.id, focusText: "Run baseline", plannedMinutes: 90 },
        { taskId: routine.id, focusText: "Speaking", plannedMinutes: 45 },
      ],
    });

    expect(planned).toHaveLength(2);
    expect(planned.map((item) => item.focusText)).toEqual(["Run baseline", "Speaking"]);
    expect(new Set(planned.map((item) => item.date)).size).toBe(1);
  });

  it("refuses an invalid Today batch before it writes any session", async () => {
    const userId = await createTestUser();
    const { tasks, sessions } = makeServices();
    const valid = await tasks.createTask(userId, { title: "Valid", priority: "high", type: "work" });
    const terminal = await tasks.createTask(userId, { title: "Closed", priority: "high", type: "work" });
    await tasks.completeTask(userId, { taskId: terminal.id });

    await expect(
      sessions.setTodayPlan(userId, {
        items: [
          { taskId: valid.id, plannedMinutes: 60 },
          { taskId: terminal.id, plannedMinutes: 60 },
        ],
      }),
    ).rejects.toThrow("no longer active");
    expect(await sessions.listSessions(userId, {})).toEqual([]);
  });

  it("refuses Today items for steps and allows multiple actions on one task", async () => {
    const userId = await createTestUser();
    const { tasks, sessions } = makeServices();
    const parent = await tasks.createTask(userId, { title: "Parent", priority: "high", type: "work" });
    const [step] = await tasks.createSubtasks(userId, { parentTaskId: parent.id, titles: ["Step"] });

    await expect(sessions.setTodayPlan(userId, { items: [{ taskId: step!.id, plannedMinutes: 60 }] })).rejects.toThrow(
      "Steps cannot",
    );
    const items = await sessions.setTodayPlan(userId, { items: [{ taskId: parent.id, plannedMinutes: 60 }, { taskId: parent.id, plannedMinutes: 60 }] });
    expect(items).toHaveLength(2);
  });

  it("preserves skipped history and creates a new item on replan", async () => {
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
    expect((await sessions.listSessions(userId, { taskId: task.id })).map((item) => item.status)).toEqual(["skipped", "planned"]);
  });

  it("replaces only planned items, cancelling omissions without rewriting history", async () => {
    const userId = await createTestUser();
    const doneTask = await createTask(userId, "Done");
    const skippedTask = await createTask(userId, "Skipped");
    const removedTask = await createTask(userId, "Removed");
    const nextTask = await createTask(userId, "Next");
    const { sessions } = makeServices();

    const initial = await sessions.setTodayPlan(userId, {
      items: [
        { taskId: doneTask.id, plannedMinutes: 30 },
        { taskId: skippedTask.id, plannedMinutes: 30 },
        { taskId: removedTask.id, plannedMinutes: 30 },
      ],
    });
    await sessions.completeSession(userId, { sessionId: initial[0]!.id });
    await sessions.skipSession(userId, { sessionId: initial[1]!.id });

    await sessions.setTodayPlan(userId, { items: [{ taskId: nextTask.id, plannedMinutes: 45 }] });

    const statuses = (await sessions.listSessions(userId, {})).map((item) => item.status).sort();
    expect(statuses).toEqual(["cancelled", "done", "planned", "skipped"]);
  });

  it("rejects a timed item whose local date differs from its session date", async () => {
    const userId = await createTestUser("Asia/Bangkok");
    const task = await createTask(userId);
    const { sessions } = makeServices();

    await expect(
      sessions.planSession(userId, {
        taskId: task.id,
        date: "2026-09-07",
        plannedMinutes: 30,
        startAt: "2026-09-08T09:00:00.000Z",
      }),
    ).rejects.toThrow("local calendar day");
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

    expect(revised.status).toBe("planned");
    expect((await sessions.listSessions(userId, { taskId: task.id })).map((item) => item.status)).toEqual(["done", "planned"]);
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
      sessionId: planned.id,
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

  it("does not let skip rewrite completed history", async () => {
    const userId = await createTestUser();
    const task = await createTask(userId);
    const { sessions } = makeServices();
    const planned = await sessions.planSession(userId, { taskId: task.id, plannedMinutes: 60 });
    await sessions.completeSession(userId, { sessionId: planned.id, actualMinutes: 30 });

    await expect(sessions.skipSession(userId, { sessionId: planned.id })).rejects.toThrow("Session not found");
    await expect(sessions.completeSession(userId, { sessionId: planned.id })).rejects.toThrow("Session not found");
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

  it("lists a day's sessions in explicit plan position", async () => {
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

    expect(today.map((s) => s.task.title)).toEqual(["Untimed", "Evening", "Morning"]);
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
