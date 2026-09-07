import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleReminderService } from "../services/reminder-service.js";
import { DrizzleSessionService } from "../services/session-service.js";
import { DrizzleTaskService } from "../services/task-service.js";
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
    expect(names).toContain("completeSession");
    expect(names).toContain("skipSession");
    expect(names).toContain("listSessions");
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
