import "./test-support/env.js";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@persona/db";
import { buildApp } from "./app.js";
import { createTestUser, getTestDb, resetTestDb } from "./test-support/db.js";
import { mintDesktopToken } from "./auth/desktop-token.js";
import { dateKeyInTimezone } from "./services/local-time.js";

const BFF = { authorization: "Bearer test-bff-secret", "content-type": "application/json" };

async function createRoutine(app: ReturnType<typeof buildApp>, userId: string, title = "Học tiếng Anh") {
  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: BFF,
    payload: { userId, title, monthlyTargetMinutes: 20 * 60 },
  });
  const task = created.json().task;
  await app.inject({
    method: "PATCH",
    url: `/tasks/${task.id}`,
    headers: BFF,
    payload: { userId, status: "in_progress" },
  });
  return task;
}

async function autoReminderKinds(taskId: string): Promise<string[]> {
  const rows = await getTestDb()
    .select()
    .from(schema.reminders)
    .where(and(eq(schema.reminders.taskId, taskId), eq(schema.reminders.status, "active")));
  return rows.filter((r) => r.source === "auto").map((r) => r.kind as string);
}

describe("session routes", () => {
  beforeEach(resetTestDb);

  it("requires the BFF shared secret, like every other non-desktop route", async () => {
    const app = buildApp({ db: getTestDb() });
    const response = await app.inject({ method: "GET", url: "/sessions/today?userId=whatever" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects /desktop/today with no token", async () => {
    const app = buildApp({ db: getTestDb() });
    const response = await app.inject({ method: "GET", url: "/desktop/today" });
    expect(response.statusCode).toBe(401);
  });

  it("plans, lists and completes a session from the widget", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const auth = { authorization: `Bearer ${raw}`, "content-type": "application/json" };
    const task = await createRoutine(app, userId);

    const planned = await app.inject({
      method: "POST",
      url: "/desktop/sessions",
      headers: auth,
      payload: { taskId: task.id, plannedMinutes: 60 },
    });
    expect(planned.statusCode).toBe(201);
    const session = planned.json().session;

    const today = await app.inject({ method: "GET", url: "/desktop/today", headers: auth });
    expect(today.statusCode).toBe(200);
    const body = today.json();
    expect(body.date).toBe(dateKeyInTimezone(new Date(), "Asia/Bangkok"));
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].task.id).toBe(task.id);
    // The routine also shows up as still wanting time, which is what lets the
    // widget say "1h planned of the 1.2h today wants".
    expect(body.ongoing).toHaveLength(1);
    expect(body.ongoing[0].pace.suggestedTodayMinutes).toBeGreaterThan(0);

    const done = await app.inject({
      method: "POST",
      url: `/desktop/sessions/${session.id}/complete`,
      headers: auth,
      payload: {},
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().session.actualMinutes).toBe(60);
  });

  it("credits a completed session to the task's pace", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const auth = { authorization: `Bearer ${raw}`, "content-type": "application/json" };
    const task = await createRoutine(app, userId);

    const planned = await app.inject({
      method: "POST",
      url: "/desktop/sessions",
      headers: auth,
      payload: { taskId: task.id, plannedMinutes: 90 },
    });
    await app.inject({
      method: "POST",
      url: `/desktop/sessions/${planned.json().session.id}/complete`,
      headers: auth,
      payload: { actualMinutes: 45 },
    });

    const today = await app.inject({ method: "GET", url: "/desktop/today", headers: auth });
    expect(today.json().ongoing[0].pace.spentMinutes).toBe(45);
  });

  it("never lets a desktop token plan against someone else's task", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const theirTask = await createRoutine(app, otherUserId, "Not yours");

    const response = await app.inject({
      method: "POST",
      url: "/desktop/sessions",
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      // Identity comes only from the token, so a spoofed userId changes nothing.
      payload: { taskId: theirTask.id, plannedMinutes: 60, userId: otherUserId },
    });

    expect(response.statusCode).not.toBe(201);
  });

  it("rejects a malformed date and a nonsense duration", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();

    const badDate = await app.inject({
      method: "GET",
      url: `/sessions/today?userId=${userId}&date=07-09-2026`,
      headers: BFF,
    });
    expect(badDate.statusCode).toBe(400);

    const task = await createRoutine(app, userId);
    const badMinutes = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: BFF,
      payload: { userId, taskId: task.id, plannedMinutes: 0 },
    });
    expect(badMinutes.statusCode).toBe(400);
  });

  it("designates a routine from the widget, starting the task so it actually appears", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const auth = { authorization: `Bearer ${raw}`, "content-type": "application/json" };
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: BFF,
      payload: { userId, title: "Học tiếng Anh" },
    });
    const task = created.json().task;

    const response = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/routine`,
      headers: auth,
      payload: { monthlyTargetMinutes: 20 * 60 },
    });

    expect(response.statusCode).toBe(200);
    // Starting it is the load-bearing half: a routine only reaches `ongoing`
    // while in_progress, so without it the widget would look broken.
    expect(response.json().task).toMatchObject({
      monthlyTargetMinutes: 20 * 60,
      status: "in_progress",
    });

    const today = await app.inject({ method: "GET", url: "/desktop/today", headers: auth });
    expect(today.json().ongoing.map((t: { id: string }) => t.id)).toEqual([task.id]);
  });

  it("drops the deadline, and its reminders, when a dated task becomes a routine", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: BFF,
      payload: {
        userId,
        title: "Học tiếng Anh",
        dueAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
      },
    });
    const task = created.json().task;
    // The dated task really did earn reminders, so the assertion below is
    // about them being cleared rather than never having existed.
    expect(await autoReminderKinds(task.id)).not.toEqual([]);

    const response = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/routine`,
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      payload: { monthlyTargetMinutes: 20 * 60 },
    });

    expect(response.json().task.dueAt).toBeNull();
    // Left in place, "Đến hạn: Học tiếng Anh" would arrive over Telegram for a
    // task the Now view deliberately shows no deadline for.
    expect(await autoReminderKinds(task.id)).toEqual([]);
  });

  it("leaves an already-started task's status alone", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: BFF,
      payload: { userId, title: "Gym" },
    });
    const task = created.json().task;
    await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}`,
      headers: BFF,
      payload: { userId, status: "in_progress" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/routine`,
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      payload: { monthlyTargetMinutes: 480 },
    });

    expect(response.json().task.status).toBe("in_progress");
  });

  it("stops measuring a routine without stopping the task", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const auth = { authorization: `Bearer ${raw}`, "content-type": "application/json" };
    const task = await createRoutine(app, userId);

    const response = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/routine`,
      headers: auth,
      payload: { monthlyTargetMinutes: null },
    });

    expect(response.statusCode).toBe(200);
    // "No longer measured monthly" is not "no longer doing this".
    expect(response.json().task).toMatchObject({
      monthlyTargetMinutes: null,
      status: "in_progress",
    });
    const today = await app.inject({ method: "GET", url: "/desktop/today", headers: auth });
    expect(today.json().ongoing).toEqual([]);
  });

  it("rejects an absurd monthly target and an unknown task", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const auth = { authorization: `Bearer ${raw}`, "content-type": "application/json" };
    const task = await createRoutine(app, userId);

    const tooBig = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/routine`,
      headers: auth,
      payload: { monthlyTargetMinutes: 999_999 },
    });
    expect(tooBig.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/desktop/tasks/2b1f6a2e-0000-4000-8000-000000000000/routine",
      headers: auth,
      payload: { monthlyTargetMinutes: 600 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("never lets a desktop token designate someone else's task", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");
    const theirTask = await createRoutine(app, otherUserId, "Not yours");

    const response = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${theirTask.id}/routine`,
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      payload: { monthlyTargetMinutes: 600 },
    });

    expect(response.statusCode).toBe(404);
  });
});
