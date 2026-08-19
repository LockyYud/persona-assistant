import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleTaskService } from "./task-service.js";

describe("DrizzleTaskService.listNowTasks", () => {
  beforeEach(resetTestDb);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets overdue / today / nextUp correctly and never silently drops unscheduled tasks", async () => {
    // Pinned to a fixed instant well clear of the Asia/Bangkok day boundary
    // (2026-01-15 12:00 +07:00) so "today" bucketing isn't flaky depending
    // on what time this test happens to run.
    const now = new Date("2026-01-15T05:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const userId = await createTestUser("Asia/Bangkok");
    const service = new DrizzleTaskService(getTestDb());

    const overdue = await service.createTask(userId, {
      title: "Overdue task",
      priority: "medium",
      type: "personal",
      dueAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    });
    const today = await service.createTask(userId, {
      title: "Due later today",
      priority: "medium",
      type: "personal",
      dueAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
    const future = await service.createTask(userId, {
      title: "Due next week",
      priority: "medium",
      type: "personal",
      dueAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await service.createTask(userId, { title: "No deadline yet", priority: "low", type: "personal" });
    await service.createTask(userId, { title: "Also no deadline", priority: "low", type: "personal" });

    const result = await service.listNowTasks(userId);

    expect(result.overdue.map((t) => t.id)).toEqual([overdue.id]);
    expect(result.today.map((t) => t.id)).toEqual([today.id]);
    // nextUp only surfaces when overdue/today are both empty, so with an
    // overdue task present it must stay null even though `future` exists.
    expect(result.nextUp).toBeNull();
    expect(result.unscheduledCount).toBe(2);
    void future;
  });

  it("returns unscheduled tasks oldest-first, not just a count", async () => {
    const userId = await createTestUser();
    const service = new DrizzleTaskService(getTestDb());

    const first = await service.createTask(userId, { title: "First backlog item", priority: "low", type: "personal" });
    const second = await service.createTask(userId, { title: "Second backlog item", priority: "low", type: "personal" });

    const result = await service.listNowTasks(userId);

    expect(result.unscheduledCount).toBe(2);
    expect(result.unscheduled.map((t) => t.id)).toEqual([first.id, second.id]);
  });

  it("surfaces nextUp only when there's nothing overdue or due today", async () => {
    const now = new Date("2026-01-15T05:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const userId = await createTestUser("Asia/Bangkok");
    const service = new DrizzleTaskService(getTestDb());

    const soonest = await service.createTask(userId, {
      title: "Soonest future task",
      priority: "medium",
      type: "personal",
      dueAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await service.createTask(userId, {
      title: "Later future task",
      priority: "medium",
      type: "personal",
      dueAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await service.listNowTasks(userId);

    expect(result.overdue).toHaveLength(0);
    expect(result.today).toHaveLength(0);
    expect(result.nextUp?.id).toBe(soonest.id);
  });

  it("does not surface done/cancelled tasks in any bucket", async () => {
    const userId = await createTestUser();
    const service = new DrizzleTaskService(getTestDb());

    const task = await service.createTask(userId, {
      title: "Will be completed",
      priority: "medium",
      type: "personal",
      dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await service.completeTask(userId, { taskId: task.id });

    const result = await service.listNowTasks(userId);
    expect(result.overdue).toHaveLength(0);
    expect(result.unscheduledCount).toBe(0);
  });
});

describe("DrizzleTaskService.completeTask", () => {
  beforeEach(resetTestDb);

  it("is idempotent — completing an already-done task again just no-ops", async () => {
    const userId = await createTestUser();
    const service = new DrizzleTaskService(getTestDb());
    const task = await service.createTask(userId, { title: "Ship it", priority: "medium", type: "personal" });

    const first = await service.completeTask(userId, { taskId: task.id });
    const second = await service.completeTask(userId, { taskId: task.id });

    expect(first.status).toBe("done");
    expect(second.status).toBe("done");
  });
});
