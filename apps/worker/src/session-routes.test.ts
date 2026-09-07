import "./test-support/env.js";
import { beforeEach, describe, expect, it } from "vitest";
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
});
