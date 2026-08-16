import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type Database } from "@persona/db";
import { TelegramNotificationChannel } from "@persona/integrations";
import { chatInputSchema, createTaskInputSchema, updateTaskInputSchema } from "@persona/core";
import { config } from "./config.js";
import { DrizzleTaskService } from "./services/task-service.js";
import { DrizzleReminderService } from "./services/reminder-service.js";
import { OpenAICompatibleAgentAdapter } from "./agent/openai-compatible-adapter.js";
import { executeTool } from "./agent/tools.js";
import { resolveApproval } from "./agent/approvals.js";
import { verifyTickSignature } from "./auth/internal-signature.js";
import { runTick } from "./scheduler/tick.js";
import { makeChatIdResolver } from "./scheduler/chat-id-resolver.js";

export interface BuildAppOptions {
  db?: Database;
}

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

  const taskService = new DrizzleTaskService(db);
  const reminderService = new DrizzleReminderService(db);
  const agentRuntime = new OpenAICompatibleAgentAdapter(db, taskService, reminderService, config.llm);
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
      request.url === "/health"
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (authHeader !== `Bearer ${config.bffSharedSecret}`) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Querystring: { email: string } }>("/users/me", async (request, reply) => {
    const { email } = request.query;
    if (!email) return reply.code(400).send({ error: "email is required" });

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) return reply.code(404).send({ error: "user not found" });

    return { user: { id: user.id, email: user.email, timezone: user.timezone } };
  });

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

    const result = await runTick(db, notificationChannel, resolveChatId);
    return result;
  });

  return app;
}
