import "./test-support/env.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createTestUser, getTestDb, resetTestDb } from "./test-support/db.js";
import { mintDesktopToken } from "./auth/desktop-token.js";

describe("desktop routes", () => {
  beforeEach(resetTestDb);

  it("rejects /desktop/* requests with no token", async () => {
    const app = buildApp({ db: getTestDb() });
    const response = await app.inject({ method: "GET", url: "/desktop/tasks/now" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects /desktop/* requests with a garbage token", async () => {
    const app = buildApp({ db: getTestDb() });
    const response = await app.inject({
      method: "GET",
      url: "/desktop/tasks/now",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("resolves /desktop/tasks/now for a valid token, scoped to that user only", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");

    const response = await app.inject({
      method: "GET",
      url: "/desktop/tasks/now",
      headers: { authorization: `Bearer ${raw}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.now).toEqual({ overdue: [], today: [], nextUp: null, unscheduledCount: 0 });
  });

  it("never accepts a client-supplied userId on /desktop/* — identity comes only from the token", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");

    // Create a task for the *other* user, then try to complete it using
    // userId's token with otherUserId spoofed into the body.
    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { authorization: "Bearer test-bff-secret", "content-type": "application/json" },
      payload: { userId: otherUserId, title: "Not yours" },
    });
    const otherTask = createResponse.json().task;

    const completeResponse = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${otherTask.id}/complete`,
      headers: { authorization: `Bearer ${raw}` },
      payload: { userId: otherUserId },
    });

    // completeTask throws "Task not found" because it's scoped by the real
    // (token-derived) userId, not the userId in the body — Fastify's default
    // error handler turns that into a 500, which is still "did not complete
    // someone else's task", the property under test.
    expect(completeResponse.statusCode).not.toBe(200);
  });

  it("still requires the BFF shared secret on non-desktop routes, unaffected by desktop-token support", async () => {
    const app = buildApp({ db: getTestDb() });
    const response = await app.inject({ method: "GET", url: "/tasks?userId=whatever" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects snooze minutes outside the 5..10080 bound", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");

    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { authorization: "Bearer test-bff-secret", "content-type": "application/json" },
      payload: { userId, title: "Snooze me", dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });
    const task = createResponse.json().task;

    const tooLow = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/snooze`,
      headers: { authorization: `Bearer ${raw}` },
      payload: { minutes: 1 },
    });
    const tooHigh = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/snooze`,
      headers: { authorization: `Bearer ${raw}` },
      payload: { minutes: 999_999 },
    });
    const valid = await app.inject({
      method: "POST",
      url: `/desktop/tasks/${task.id}/snooze`,
      headers: { authorization: `Bearer ${raw}` },
      payload: { minutes: 60 },
    });

    expect(tooLow.statusCode).toBe(400);
    expect(tooHigh.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
  });
});
