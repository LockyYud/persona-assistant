import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { createDb, schema, type Database } from "@persona/db";
import { NotionClient, TavilyClient, TelegramNotificationChannel } from "@persona/integrations";
import { chatInputSchema, createTaskInputSchema, updateTaskInputSchema } from "@persona/core";
import { config } from "./config.js";
import { DrizzleTaskService } from "./services/task-service.js";
import { DrizzleReminderService } from "./services/reminder-service.js";
import { OpenAICompatibleAgentAdapter } from "./agent/openai-compatible-adapter.js";
import { executeTool } from "./agent/tools.js";
import { resolveApproval } from "./agent/approvals.js";
import { verifyTickSignature } from "./auth/internal-signature.js";
import { checkRateLimit, clearAttempts, recordFailedAttempt } from "./auth/password-rate-limiter.js";
import {
  listDesktopTokens,
  mintDesktopToken,
  revokeDesktopToken,
  verifyDesktopToken,
} from "./auth/desktop-token.js";
import { runTick } from "./scheduler/tick.js";
import { makeChatIdResolver } from "./scheduler/chat-id-resolver.js";

export interface BuildAppOptions {
  db?: Database;
}

// Desktop tokens are scoped to "read tasks / complete task / snooze task"
// (push a task's dueAt forward) — see /settings copy on the web app. Bounds
// keep snooze from being usable as a general-purpose "reschedule to
// anything" primitive: 5 minutes minimum (below that, just wait), 1 week
// maximum (beyond that, edit the task's due date directly instead).
const SNOOZE_MIN_MINUTES = 5;
const SNOOZE_MAX_MINUTES = 10_080;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const db = options.db ?? createDb(config.databaseUrl);

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body: string, done) => {
      (request as { rawBody?: string }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  const notion = config.notionApiKey ? new NotionClient(config.notionApiKey) : undefined;
  const taskService = new DrizzleTaskService(db, notion, config.notionTasksDatabaseId);
  const reminderService = new DrizzleReminderService(db);
  const tavily = config.tavilyApiKey ? new TavilyClient(config.tavilyApiKey) : undefined;
  const agentRuntime = new OpenAICompatibleAgentAdapter(
    db,
    taskService,
    reminderService,
    config.llm,
    notion,
    tavily,
  );
  const notificationChannel = new TelegramNotificationChannel(config.telegramBotToken);
  const resolveChatId = makeChatIdResolver(db);

  /**
   * The only place a pending approval actually moves forward. Called from a
   * real user-originated signal (Telegram button callback, web button) —
   * never from the model.
   */
  async function decideApproval(
    userId: string,
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const approval = await resolveApproval(db, approvalId, userId, decision);
    if (!approval) return { ok: false, error: "No matching pending approval found." };

    if (decision === "rejected") return { ok: true, result: { status: "rejected" } };

    const result = await executeTool(approval.action, approval.payload, {
      userId,
      db,
      taskService,
      reminderService,
    });
    return { ok: true, result };
  }

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/internal/") ||
      request.url.startsWith("/telegram/") ||
      request.url.startsWith("/desktop/") ||
      request.url === "/health"
    ) {
      // /desktop/* is gated separately below by the desktop-token
      // preHandler, never by the BFF shared secret.
      return;
    }

    const authHeader = request.headers.authorization;
    if (authHeader !== `Bearer ${config.bffSharedSecret}`) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  /**
   * Resolves the desktop-token bearer on /desktop/* routes to its owning
   * userId, or replies 401. This is the ONLY source of userId for these
   * routes — never trust a client-supplied one here.
   */
  async function requireDesktopUserId(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | undefined> {
    const authHeader = request.headers.authorization;
    const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const userId = raw ? await verifyDesktopToken(db, raw) : null;

    if (!userId) {
      reply.code(401).send({ error: "invalid or revoked desktop token" });
      return undefined;
    }

    return userId;
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Querystring: { email: string } }>("/users/me", async (request, reply) => {
    const { email } = request.query;
    if (!email) return reply.code(400).send({ error: "email is required" });

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) return reply.code(404).send({ error: "user not found" });

    return { user: { id: user.id, email: user.email, timezone: user.timezone } };
  });

  app.post<{ Body: { password?: string; clientIp?: string } }>(
    "/auth/verify-password",
    async (request, reply) => {
      const { password, clientIp } = request.body ?? {};
      const rateLimitKey = clientIp || request.ip;

      const rateLimit = checkRateLimit(rateLimitKey);
      if (!rateLimit.allowed) {
        return reply
          .code(429)
          .send({ ok: false, error: "Too many attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
      }

      if (!password) {
        recordFailedAttempt(rateLimitKey);
        return reply.code(400).send({ ok: false, error: "password is required" });
      }

      const valid = await bcrypt.compare(password, config.authPasswordHash);
      if (!valid) {
        recordFailedAttempt(rateLimitKey);
        return reply.code(401).send({ ok: false, error: "invalid password" });
      }

      clearAttempts(rateLimitKey);
      return { ok: true, email: config.authAllowedEmail };
    },
  );

  app.post("/chat", async (request, reply) => {
    const parsed = chatInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const result = await agentRuntime.chat(parsed.data);
    return result;
  });

  app.get<{ Querystring: { userId: string; status?: string } }>("/tasks", async (request, reply) => {
    const { userId, status } = request.query;
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const tasks = await taskService.listTasks(userId, {
      status: status as never,
    });
    return { tasks };
  });

  app.get<{ Querystring: { userId: string } }>("/tasks/now", async (request, reply) => {
    const { userId } = request.query;
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const now = await taskService.listNowTasks(userId);
    return { now };
  });

  app.post<{ Params: { taskId: string }; Body: { userId: string } }>(
    "/tasks/:taskId/complete",
    async (request, reply) => {
      const { userId } = request.body;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const task = await taskService.completeTask(userId, { taskId: request.params.taskId });
      return { task };
    },
  );

  app.post<{ Body: { userId: string } & Record<string, unknown> }>("/tasks", async (request, reply) => {
    const { userId, ...rest } = request.body;
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const parsed = createTaskInputSchema.safeParse(rest);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const task = await taskService.createTask(userId, parsed.data);
    return reply.code(201).send({ task });
  });

  app.patch<{ Params: { taskId: string }; Body: { userId: string } & Record<string, unknown> }>(
    "/tasks/:taskId",
    async (request, reply) => {
      const { userId, ...rest } = request.body;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const parsed = updateTaskInputSchema.safeParse({ ...rest, taskId: request.params.taskId });
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const task = await taskService.updateTask(userId, parsed.data);
      return { task };
    },
  );

  app.post<{
    Params: { approvalId: string };
    Body: { userId: string; decision: "approved" | "rejected" };
  }>("/approvals/:approvalId/decision", async (request, reply) => {
    const { userId, decision } = request.body;
    if (!userId || (decision !== "approved" && decision !== "rejected")) {
      return reply.code(400).send({ error: "userId and decision ('approved'|'rejected') are required" });
    }

    const outcome = await decideApproval(userId, request.params.approvalId, decision);
    if (!outcome.ok) return reply.code(404).send({ error: outcome.error });

    return { decision, result: outcome.result };
  });

  // --- Desktop token management (Next.js server only, gated by the BFF
  // shared secret like every other route above) ---

  app.post<{ Body: { userId: string; label?: string } }>(
    "/auth/desktop-tokens",
    async (request, reply) => {
      const { userId, label } = request.body;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const { token, raw } = await mintDesktopToken(db, userId, label?.trim() || "Desktop");
      return reply.code(201).send({ token, raw });
    },
  );

  app.get<{ Querystring: { userId: string } }>("/auth/desktop-tokens", async (request, reply) => {
    const { userId } = request.query;
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const tokens = await listDesktopTokens(db, userId);
    return { tokens };
  });

  app.delete<{ Params: { id: string }; Body: { userId: string } }>(
    "/auth/desktop-tokens/:id",
    async (request, reply) => {
      const { userId } = request.body;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const revoked = await revokeDesktopToken(db, userId, request.params.id);
      if (!revoked) return reply.code(404).send({ error: "token not found" });
      return { ok: true };
    },
  );

  // --- Desktop routes: gated by a desktop token (see requireDesktopUserId
  // above), never by the BFF shared secret and never by a client userId. ---

  app.get("/desktop/tasks/now", async (request, reply) => {
    const userId = await requireDesktopUserId(request, reply);
    if (!userId) return;

    const now = await taskService.listNowTasks(userId);
    return { now };
  });

  app.post("/desktop/tasks", async (request, reply) => {
    const userId = await requireDesktopUserId(request, reply);
    if (!userId) return;

    const parsed = createTaskInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const task = await taskService.createTask(userId, parsed.data);
    return reply.code(201).send({ task });
  });

  app.post<{ Params: { taskId: string } }>(
    "/desktop/tasks/:taskId/complete",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const task = await taskService.completeTask(userId, { taskId: request.params.taskId });
      return { task };
    },
  );

  app.post<{ Params: { taskId: string }; Body: { minutes?: number } }>(
    "/desktop/tasks/:taskId/snooze",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const existing = await taskService.getTask(userId, request.params.taskId);
      if (!existing) return reply.code(404).send({ error: "task not found" });

      const minutes = request.body?.minutes ?? 60;
      if (!Number.isInteger(minutes) || minutes < SNOOZE_MIN_MINUTES || minutes > SNOOZE_MAX_MINUTES) {
        return reply.code(400).send({
          error: `minutes must be an integer between ${SNOOZE_MIN_MINUTES} and ${SNOOZE_MAX_MINUTES}`,
        });
      }

      const base = existing.dueAt && existing.dueAt.getTime() > Date.now() ? existing.dueAt : new Date();
      const dueAt = new Date(base.getTime() + minutes * 60_000);

      const task = await taskService.updateTask(userId, {
        taskId: request.params.taskId,
        dueAt: dueAt.toISOString(),
      });
      return { task };
    },
  );

  app.post<{
    Body: {
      message?: { chat: { id: number }; text?: string };
      callback_query?: {
        id: string;
        message?: { message_id: number; chat: { id: number } };
        data?: string;
      };
    };
  }>("/telegram/webhook", async (request, reply) => {
    const secretHeader = request.headers["x-telegram-bot-api-secret-token"];
    if (!config.telegramWebhookSecret || secretHeader !== config.telegramWebhookSecret) {
      return reply.code(401).send({ error: "invalid webhook secret" });
    }

    const callback = request.body?.callback_query;
    if (callback) {
      const chatId = callback.message?.chat?.id;
      const messageId = callback.message?.message_id;
      const [, approvalId, decisionWord] = callback.data?.split(":") ?? [];

      if (chatId === undefined || !approvalId || (decisionWord !== "approve" && decisionWord !== "reject")) {
        await notificationChannel.answerCallbackQuery(callback.id);
        return reply.code(200).send({ ok: true });
      }

      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.telegramChatId, String(chatId)));

      if (!user) {
        await notificationChannel.answerCallbackQuery(callback.id, "Not linked to an account.");
        return reply.code(200).send({ ok: true });
      }

      const decision = decisionWord === "approve" ? "approved" : "rejected";
      const outcome = await decideApproval(user.id, approvalId, decision);

      const resultText = !outcome.ok
        ? `⚠️ ${outcome.error}`
        : decision === "approved"
          ? "✅ Đã xác nhận và thực hiện."
          : "❌ Đã huỷ.";

      await notificationChannel.answerCallbackQuery(callback.id);
      if (messageId !== undefined) {
        await notificationChannel.editMessageText(String(chatId), messageId, resultText);
      }

      return reply.code(200).send({ ok: true });
    }

    const message = request.body?.message;
    const text = message?.text;
    const chatId = message?.chat?.id;

    if (!text || chatId === undefined) {
      return reply.code(200).send({ ok: true });
    }

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.telegramChatId, String(chatId)));

    if (!user) {
      await notificationChannel.send({
        chatId: String(chatId),
        text: "This bot is private and not linked to your account.",
      });
      return reply.code(200).send({ ok: true });
    }

    const result = await agentRuntime.chat({ userId: user.id, message: text });

    if (result.pendingApproval) {
      await notificationChannel.sendWithApprovalButtons(
        { chatId: String(chatId), text: result.reply },
        { approvalId: result.pendingApproval.approvalId },
      );
    } else {
      await notificationChannel.send({ chatId: String(chatId), text: result.reply });
    }

    return reply.code(200).send({ ok: true });
  });

  app.post("/internal/tick", async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? "";
    const signature = request.headers["x-signature"];
    const timestamp = request.headers["x-timestamp"];

    const isValid = verifyTickSignature(
      config.internalHmacSecret,
      rawBody,
      typeof signature === "string" ? signature : undefined,
      typeof timestamp === "string" ? timestamp : undefined,
    );

    if (!isValid) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const result = await runTick(
      db,
      notificationChannel,
      resolveChatId,
      notion,
      config.notionTasksDatabaseId,
    );
    return result;
  });

  return app;
}
