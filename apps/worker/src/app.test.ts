import "./test-support/env.js";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@persona/db";
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
    expect(body.now).toEqual({
      overdue: [],
      today: [],
      nextUp: null,
      unscheduledCount: 0,
      unscheduled: [],
    });
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

  it("creates a task via POST /desktop/tasks, scoped to the token's user", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");

    const response = await app.inject({
      method: "POST",
      url: "/desktop/tasks",
      headers: { authorization: `Bearer ${raw}` },
      payload: { title: "Quick-added from widget", priority: "urgent" },
    });

    expect(response.statusCode).toBe(201);
    const task = response.json().task;
    expect(task.userId).toBe(userId);
    expect(task.title).toBe("Quick-added from widget");
    expect(task.priority).toBe("urgent");
  });

  it("rejects POST /desktop/tasks with an invalid body", async () => {
    const app = buildApp({ db: getTestDb() });
    const userId = await createTestUser();
    const { raw } = await mintDesktopToken(getTestDb(), userId, "test");

    const response = await app.inject({
      method: "POST",
      url: "/desktop/tasks",
      headers: { authorization: `Bearer ${raw}` },
      payload: { title: "" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("telegram webhook resilience", () => {
  beforeEach(resetTestDb);

  const WEBHOOK_SECRET = "test-webhook-secret";

  /**
   * A Telegram channel that records what was sent. The callback/edit methods
   * are unused by these tests but required by the interface, so they are
   * no-ops rather than throwing.
   */
  function stubChannel(overrides: { send?: (text: string) => void; failSend?: boolean } = {}) {
    return {
      send: async ({ text }: { chatId: string; text: string }) => {
        if (overrides.failSend) throw new Error("Telegram down");
        overrides.send?.(text);
        return { providerMessageId: "1" };
      },
      sendWithApprovalButtons: async () => ({ providerMessageId: "1" }),
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
    };
  }

  /** An agent runtime whose turn always throws, standing in for a provider outage. */
  function failingRuntime(onCall?: () => void) {
    return {
      chat: async () => {
        onCall?.();
        throw new Error("LLM exploded");
      },
      runTriggeredWorkflow: async () => {},
    };
  }

  async function linkedUser(chatId: string) {
    const userId = await createTestUser();
    await getTestDb()
      .update(schema.users)
      .set({ telegramChatId: chatId })
      .where(eq(schema.users.id, userId));
    return userId;
  }

  function postMessage(app: ReturnType<typeof buildApp>, chatId: number, text: string) {
    return app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      payload: { message: { chat: { id: chatId }, text } },
    });
  }

  it("still answers 200 when the turn throws, so Telegram does not redeliver", async () => {
    await linkedUser("555");
    const sent: string[] = [];

    const app = buildApp({
      db: getTestDb(),
      agentRuntime: failingRuntime(),
      notificationChannel: stubChannel({ send: (text) => sent.push(text) }),
    });

    const response = await postMessage(app, 555, "hello");

    // A non-2xx makes Telegram resend the same message, which re-runs the
    // whole agent loop and can duplicate real side effects like task creation.
    expect(response.statusCode).toBe(200);
    // The failure still has to reach the user rather than vanishing.
    expect(sent.join("")).toContain("lỗi");
  });

  it("answers 200 even when the failure notice itself cannot be delivered", async () => {
    await linkedUser("556");

    const app = buildApp({
      db: getTestDb(),
      agentRuntime: failingRuntime(),
      notificationChannel: stubChannel({ failSend: true }),
    });

    const response = await postMessage(app, 556, "hello");
    expect(response.statusCode).toBe(200);
  });

  it("/new opens a fresh telegram thread without invoking the model", async () => {
    const userId = await linkedUser("557");
    let chatCalls = 0;

    const app = buildApp({
      db: getTestDb(),
      agentRuntime: failingRuntime(() => {
        chatCalls += 1;
      }),
      notificationChannel: stubChannel(),
    });

    const response = await postMessage(app, 557, "/new");

    expect(response.statusCode).toBe(200);
    expect(chatCalls).toBe(0);
    const threads = await getTestDb()
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.channel).toBe("telegram");
  });
});
