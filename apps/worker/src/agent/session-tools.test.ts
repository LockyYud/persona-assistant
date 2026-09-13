import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleReminderService } from "../services/reminder-service.js";
import { DrizzleSessionService } from "../services/session-service.js";
import { DrizzleTaskService } from "../services/task-service.js";
import { dateKeyInTimezone } from "../services/local-time.js";
import { buildToolDefinitions, executeTool, type ToolContext } from "./tools.js";

function makeContext(userId: string): ToolContext {
  const db = getTestDb();
  return {
    userId,
    db,
    taskService: new DrizzleTaskService(db),
    reminderService: new DrizzleReminderService(db),
    sessionService: new DrizzleSessionService(db),
  };
}

describe("session tools", () => {
  beforeEach(resetTestDb);

  it("registers every session tool the policy table allowlists", () => {
    const names = buildToolDefinitions().map((tool) => tool.function.name);

    // A tool missing here but present in permissions.ts would silently never
    // be callable; one present here but missing there defaults to "confirm"
    // and would surprise the user with an approval prompt.
    expect(names).toContain("listToday");
    expect(names).toContain("planSession");
    expect(names).toContain("planToday");
    expect(names).toContain("completeSession");
    expect(names).toContain("skipSession");
    expect(names).toContain("listSessions");
  });

  it("returns yesterday's unfinished commitments without carrying them forward", async () => {
    const userId = await createTestUser();
    const ctx = makeContext(userId);
    const task = await ctx.taskService.createTask(userId, {
      title: "RAG Lab",
      priority: "high",
      type: "work",
    });
    const today = dateKeyInTimezone(new Date(), "Asia/Bangkok");
    const yesterday = new Date(`${today}T12:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await ctx.sessionService.planSession(userId, {
      taskId: task.id,
      date: yesterday.toISOString().slice(0, 10),
      plannedMinutes: 90,
      focusText: "Run baseline",
    });

    const result = (await executeTool("listToday", {}, ctx)) as {
      sessions: unknown[];
      missedYesterday: { taskId: string; focusText: string | null }[];
    };
    expect(result.sessions).toEqual([]);
    expect(result.missedYesterday).toHaveLength(1);
    expect(result.missedYesterday[0]).toMatchObject({ taskId: task.id, focusText: "Run baseline" });
  });

  it("accepts a confirmed Today batch through the tool contract", async () => {
    const userId = await createTestUser();
    const ctx = makeContext(userId);
    const first = await ctx.taskService.createTask(userId, { title: "RAG", priority: "high", type: "work" });
    const second = await ctx.taskService.createTask(userId, { title: "CV", priority: "medium", type: "work" });

    const result = (await executeTool(
      "planToday",
      {
        items: [
          { taskId: first.id, focusText: "Run baseline", plannedMinutes: 90 },
          { taskId: second.id, focusText: "Review CV", plannedMinutes: 30 },
        ],
      },
      ctx,
    )) as { focusText: string | null }[];
    expect(result.map((session) => session.focusText)).toEqual(["Run baseline", "Review CV"]);
  });

  it("plans a day of work from a chat-shaped call and reports it back in listToday", async () => {
    const userId = await createTestUser();
    const ctx = makeContext(userId);
    const task = await ctx.taskService.createTask(userId, {
      title: "Học tiếng Anh",
      priority: "medium",
      type: "personal",
      monthlyTargetMinutes: 20 * 60,
    });
    await ctx.taskService.updateTask(userId, { taskId: task.id, status: "in_progress" });

    // "hôm nay học tiếng Anh 1 tiếng"
    await executeTool("planSession", { taskId: task.id, plannedMinutes: 60 }, ctx);

    const today = (await executeTool("listToday", {}, ctx)) as {
      sessions: { taskId: string; plannedMinutes: number }[];
      ongoing: { id: string; pace: { suggestedTodayMinutes: number } | null }[];
    };

    expect(today.sessions).toHaveLength(1);
    expect(today.sessions[0]).toMatchObject({ taskId: task.id, plannedMinutes: 60 });
    expect(today.ongoing[0]?.id).toBe(task.id);
    expect(today.ongoing[0]?.pace?.suggestedTodayMinutes).toBeGreaterThan(0);
  });

  it("credits a session ticked off with no minutes given", async () => {
    const userId = await createTestUser();
    const ctx = makeContext(userId);
    const task = await ctx.taskService.createTask(userId, {
      title: "Gym",
      priority: "medium",
      type: "personal",
      monthlyTargetMinutes: 8 * 60,
    });
    const session = (await executeTool(
      "planSession",
      { taskId: task.id, plannedMinutes: 45 },
      ctx,
    )) as { id: string };

    const done = (await executeTool("completeSession", { sessionId: session.id }, ctx)) as {
      status: string;
      actualMinutes: number;
    };

    expect(done).toMatchObject({ status: "done", actualMinutes: 45 });
  });

  it("rejects a session length outside one day", async () => {
    const userId = await createTestUser();
    const ctx = makeContext(userId);
    const task = await ctx.taskService.createTask(userId, {
      title: "Học tiếng Anh",
      priority: "medium",
      type: "personal",
      monthlyTargetMinutes: 20 * 60,
    });

    // The model is as capable of proposing 6000 minutes as any other caller,
    // so the zod bound has to hold at the tool boundary too.
    await expect(
      executeTool("planSession", { taskId: task.id, plannedMinutes: 6000 }, ctx),
    ).rejects.toThrow();
  });
});
