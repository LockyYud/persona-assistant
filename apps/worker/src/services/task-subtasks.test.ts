import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleTaskService } from "./task-service.js";

function makeService() {
  // No Notion client passed, so writes stay local — these tests are about the
  // progress/step logic, not the mirroring.
  return new DrizzleTaskService(getTestDb());
}

describe("subtasks and derived progress", () => {
  beforeEach(resetTestDb);

  it("reports no progress for a task with no steps, rather than 0%", async () => {
    const userId = await createTestUser();
    const service = makeService();
    await service.createTask(userId, { title: "Undecomposed", priority: "medium", type: "work" });

    const [task] = await service.listTasks(userId, {});

    // The distinction that matters: a task nobody broke down is not a task
    // that's 0% done.
    expect(task?.progress).toBeNull();
    expect(task?.nextStep).toBeNull();
  });

  it("counts finished steps and surfaces the earliest unfinished one as nextStep", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Ship release",
      priority: "high",
      type: "work",
    });

    const steps = await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["Write migration", "Write sync logic", "Write tests"],
    });
    await service.completeTask(userId, { taskId: steps[0]!.id });

    const [task] = await service.listTasks(userId, {});

    expect(task?.progress).toEqual({ done: 1, total: 3 });
    // Step 1 is done, so the next actionable step is step 2 — not step 3,
    // and not the completed one.
    expect(task?.nextStep?.title).toBe("Write sync logic");
  });

  it("excludes cancelled steps from both numerator and denominator", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Plan trip",
      priority: "low",
      type: "personal",
    });

    const steps = await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["Book flight", "Book hotel", "Buy insurance"],
    });
    await service.completeTask(userId, { taskId: steps[0]!.id });
    await service.updateTask(userId, { taskId: steps[2]!.id, status: "cancelled" });

    const [task] = await service.listTasks(userId, {});

    // A step you decided not to do shouldn't leave the task looking
    // permanently unfinished — so 1/2, not 1/3.
    expect(task?.progress).toEqual({ done: 1, total: 2 });
  });

  it("keeps steps out of the top-level list and the Now view", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Parent with steps",
      priority: "medium",
      type: "work",
      dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["Step one", "Step two"],
    });

    const listed = await service.listTasks(userId, {});
    const now = await service.listNowTasks(userId);

    // One line for the task, not three.
    expect(listed.map((t) => t.title)).toEqual(["Parent with steps"]);
    expect(now.overdue.map((t) => t.title)).toEqual(["Parent with steps"]);
    expect(now.overdue[0]?.progress).toEqual({ done: 0, total: 2 });
    expect(now.overdue[0]?.nextStep?.title).toBe("Step one");
    // Steps have no dueAt of their own, so they must not pile into the
    // unscheduled bucket either.
    expect(now.unscheduledCount).toBe(0);
  });

  it("gives steps the parent's type and priority, and no due date of their own", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Urgent work item",
      priority: "urgent",
      type: "work",
      dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const [step] = await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["First step"],
    });

    expect(step?.type).toBe("work");
    expect(step?.priority).toBe("urgent");
    // Inheriting the parent's deadline would multiply every derived reminder
    // by the number of steps.
    expect(step?.dueAt).toBeNull();
    expect(step?.parentTaskId).toBe(parent.id);
  });

  it("refuses to nest a step under another step", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Top level",
      priority: "medium",
      type: "work",
    });
    const [step] = await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["Only step"],
    });

    await expect(
      service.createSubtasks(userId, { parentTaskId: step!.id, titles: ["Too deep"] }),
    ).rejects.toThrow(/another step/);
  });

  it("deletes a task's steps along with it", async () => {
    const userId = await createTestUser();
    const service = makeService();
    const parent = await service.createTask(userId, {
      title: "Will be deleted",
      priority: "medium",
      type: "work",
    });
    await service.createSubtasks(userId, {
      parentTaskId: parent.id,
      titles: ["Orphan candidate"],
    });

    const db = getTestDb();
    const { schema } = await import("@persona/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.tasks).where(eq(schema.tasks.id, parent.id));

    // A step has no meaning without its parent, hence the cascade.
    expect(await service.listSubtasks(userId, parent.id)).toHaveLength(0);
  });
});
