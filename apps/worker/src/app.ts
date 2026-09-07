import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb, schema, type Database } from "@persona/db";
import {
  NotionClient,
  TavilyClient,
  TelegramNotificationChannel,
  type TelegramChatChannel,
} from "@persona/integrations";
import {
  chatInputSchema,
  completeSessionInputSchema,
  createTaskInputSchema,
  dateKeySchema,
  listSessionsInputSchema,
  planSessionInputSchema,
  setRoutineTargetInputSchema,
  updateTaskInputSchema,
  type AgentRuntime,
} from "@persona/core";
import { config } from "./config.js";
import { DrizzleTaskService } from "./services/task-service.js";
import { DrizzleSessionService } from "./services/session-service.js";
import { DrizzleReminderService } from "./services/reminder-service.js";
import { TaskBreakdownService } from "./services/task-breakdown.js";
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
import { dateKeyInTimezone } from "./services/local-time.js";
import { runTick } from "./scheduler/tick.js";
import { makeChatIdResolver } from "./scheduler/chat-id-resolver.js";
import {
  createConversation,
  listConversations,
  loadConversationTranscript,
} from "./memory/repository.js";

export interface BuildAppOptions {
  db?: Database;
  /**
   * Overrides for the two collaborators that would otherwise reach the network
   * (an LLM provider and the Telegram API). Supplied by tests so webhook
   * behaviour can be exercised without real API calls; production passes
   * neither.
   */
  agentRuntime?: AgentRuntime;
  notificationChannel?: TelegramChatChannel;
}

// Desktop tokens are scoped to "read tasks / complete task / snooze task"
// (push a task's dueAt forward) — see /settings copy on the web app. Bounds
// keep snooze from being usable as a general-purpose "reschedule to
// anything" primitive: 5 minutes minimum (below that, just wait), 1 week
// maximum (beyond that, edit the task's due date directly instead).
const desktopStatusSchema = z.enum(["open", "in_progress"]);

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
  const sessionService = new DrizzleSessionService(db, notion, config.notionSessionsDatabaseId);
  const tavily = config.tavilyApiKey ? new TavilyClient(config.tavilyApiKey) : undefined;
  const breakdown = new TaskBreakdownService(config.llm, config.llm.breakdownModel);
  // Own client: the briefing runs from the scheduler tick, with no chat turn
  // and therefore no agent runtime involved.
  const briefingClient = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });
  const agentRuntime: AgentRuntime =
    options.agentRuntime ??
    new OpenAICompatibleAgentAdapter(
      db,
      taskService,
      reminderService,
      sessionService,
      config.llm,
      notion,
      tavily,
      breakdown,
    );
  const notificationChannel =
    options.notificationChannel ?? new TelegramNotificationChannel(config.telegramBotToken);
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
      sessionService,
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

  app.get<{ Querystring: { userId: string } }>("/conversations", async (request, reply) => {
    const { userId } = request.query;
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const conversations = await listConversations(db, userId);
    return { conversations };
  });

  app.get<{ Params: { id: string }; Querystring: { userId: string } }>(
    "/conversations/:id/messages",
    async (request, reply) => {
      const { userId } = request.query;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const messages = await loadConversationTranscript(db, userId, request.params.id);
      if (!messages) return reply.code(404).send({ error: "conversation not found" });

      return { messages };
    },
  );

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

  /**
   * "What am I doing today", for one user: the sessions they picked for their
   * own current day, plus the routines still asking for time.
   *
   * The two halves answer different questions and neither replaces the other —
   * `sessions` is what has been committed to, `ongoing` is what the month still
   * needs, each carrying the minutes to suggest. A routine appears in both when
   * it has already been planned today, which is what lets a caller show "1h
   * planned of the 1.2h today wants".
   */
  async function loadToday(userId: string, date?: string) {
    const timezone = await resolveUserTimezone(userId);
    const resolved = date ?? dateKeyInTimezone(new Date(), timezone);
    const [sessions, now] = await Promise.all([
      sessionService.listSessionsForDate(userId, resolved),
      taskService.listNowTasks(userId),
    ]);
    return { date: resolved, timezone, sessions, ongoing: now.ongoing };
  }

  async function resolveUserTimezone(userId: string): Promise<string> {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return user?.timezone ?? "Asia/Bangkok";
  }

  app.get<{ Querystring: { userId: string; date?: string } }>(
    "/sessions/today",
    async (request, reply) => {
      const { userId, date } = request.query;
      if (!userId) return reply.code(400).send({ error: "userId is required" });
      if (date && !dateKeySchema.safeParse(date).success) {
        return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
      }

      return loadToday(userId, date);
    },
  );

  app.get<{ Querystring: { userId: string; taskId?: string; from?: string; to?: string } }>(
    "/sessions",
    async (request, reply) => {
      const { userId, ...rest } = request.query;
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const parsed = listSessionsInputSchema.safeParse(rest);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const sessions = await sessionService.listSessions(userId, parsed.data);
      return { sessions };
    },
  );

  app.post<{ Body: { userId?: string } & Record<string, unknown> }>(
    "/sessions",
    async (request, reply) => {
      const { userId, ...rest } = request.body ?? {};
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const parsed = planSessionInputSchema.safeParse(rest);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const session = await sessionService.planSession(userId, parsed.data);
      return reply.code(201).send({ session });
    },
  );

  app.post<{ Params: { id: string }; Body: { userId?: string; actualMinutes?: number } }>(
    "/sessions/:id/complete",
    async (request, reply) => {
      const { userId, actualMinutes } = request.body ?? {};
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const parsed = completeSessionInputSchema.safeParse({
        sessionId: request.params.id,
        actualMinutes,
      });
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const session = await sessionService.completeSession(userId, parsed.data);
      return { session };
    },
  );

  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    "/sessions/:id/skip",
    async (request, reply) => {
      const { userId } = request.body ?? {};
      if (!userId) return reply.code(400).send({ error: "userId is required" });

      const session = await sessionService.skipSession(userId, { sessionId: request.params.id });
      return { session };
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

  /**
   * Move a task between the two *working* statuses. Deliberately narrower
   * than updateTask's full status enum: "done" belongs to /complete (which
   * also settles reminders and rolls the parent's progress up), and
   * "cancelled" is a decision that should not be one stray click away in a
   * desktop panel. So this accepts open <-> in_progress and nothing else.
   *
   * updateTask already pushes Status to the task's Notion page, so starting a
   * task here shows up in Notion without any extra work.
   */
  app.post<{ Params: { taskId: string }; Body: { status?: string } }>(
    "/desktop/tasks/:taskId/status",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const parsed = desktopStatusSchema.safeParse(request.body?.status);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'status must be "open" or "in_progress"' });
      }

      const existing = await taskService.getTask(userId, request.params.taskId);
      if (!existing) return reply.code(404).send({ error: "task not found" });

      const task = await taskService.updateTask(userId, {
        taskId: request.params.taskId,
        status: parsed.data,
      });
      return { task };
    },
  );

  /**
   * Designate a task as a routine — one pursued at a rate per month — or stop
   * treating it as one.
   *
   * Setting a target also starts the task if it was merely open. A routine
   * only reaches the `ongoing` bucket (and therefore the panel, the pace
   * figures and the briefing) while it is in_progress, so without this a user
   * would give a task a target from the widget and watch nothing happen.
   * Clearing the target deliberately does NOT stop the task: "this is no
   * longer measured monthly" is not "I am no longer doing this".
   */
  app.post<{ Params: { taskId: string }; Body: { monthlyTargetMinutes?: number | null } }>(
    "/desktop/tasks/:taskId/routine",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const parsed = setRoutineTargetInputSchema.safeParse({
        taskId: request.params.taskId,
        monthlyTargetMinutes: request.body?.monthlyTargetMinutes ?? null,
      });
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const existing = await taskService.getTask(userId, parsed.data.taskId);
      if (!existing) return reply.code(404).send({ error: "task not found" });

      const task = await taskService.updateTask(userId, {
        taskId: parsed.data.taskId,
        monthlyTargetMinutes: parsed.data.monthlyTargetMinutes,
        ...(parsed.data.monthlyTargetMinutes !== null && existing.status === "open"
          ? { status: "in_progress" as const }
          : {}),
      });
      return { task };
    },
  );

  /**
   * The widget's home screen: today's commitments and what still wants time.
   * No date parameter — a panel on a screen is always asking about now, and
   * accepting one would only add a way to get it wrong.
   */
  app.get("/desktop/today", async (request, reply) => {
    const userId = await requireDesktopUserId(request, reply);
    if (!userId) return;

    return loadToday(userId);
  });

  app.post("/desktop/sessions", async (request, reply) => {
    const userId = await requireDesktopUserId(request, reply);
    if (!userId) return;

    const parsed = planSessionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const session = await sessionService.planSession(userId, parsed.data);
    return reply.code(201).send({ session });
  });

  app.post<{ Params: { id: string }; Body: { actualMinutes?: number } }>(
    "/desktop/sessions/:id/complete",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const parsed = completeSessionInputSchema.safeParse({
        sessionId: request.params.id,
        actualMinutes: request.body?.actualMinutes,
      });
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const session = await sessionService.completeSession(userId, parsed.data);
      return { session };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/desktop/sessions/:id/skip",
    async (request, reply) => {
      const userId = await requireDesktopUserId(request, reply);
      if (!userId) return;

      const session = await sessionService.skipSession(userId, { sessionId: request.params.id });
      return { session };
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

    // Telegram has no "New chat" button, so a slash command stands in for it.
    // Creating the thread is enough to switch to it: the next message carries
    // no conversation id, and "continue my latest Telegram thread" now
    // resolves to this brand-new empty one.
    const command = text.trim().toLowerCase().split(/[\s@]/)[0];
    if (command === "/new" || command === "/newchat") {
      await createConversation(db, user.id, "telegram");
      await notificationChannel.send({
        chatId: String(chatId),
        text: "🆕 Đã bắt đầu hội thoại mới. Những tin trước đó sẽ không còn được dùng làm ngữ cảnh.",
      });
      return reply.code(200).send({ ok: true });
    }

    // Always answer Telegram with 200, even when the turn failed. A non-2xx
    // makes Telegram redeliver the same message, which re-runs the whole agent
    // loop — so a transient failure would not just retry, it could duplicate
    // real side effects like creating a task. Failures are reported to the
    // user in-chat and logged instead.
    try {
      const result = await agentRuntime.chat({
        userId: user.id,
        message: text,
        channel: "telegram",
      });

      if (result.pendingApproval) {
        await notificationChannel.sendWithApprovalButtons(
          { chatId: String(chatId), text: result.reply },
          { approvalId: result.pendingApproval.approvalId },
        );
      } else {
        await notificationChannel.send({ chatId: String(chatId), text: result.reply });
      }
    } catch (chatError) {
      app.log.error({ err: chatError }, "Telegram turn failed");
      await notificationChannel
        .send({ chatId: String(chatId), text: "⚠️ Có lỗi khi xử lý tin nhắn này. Bạn thử lại nhé." })
        .catch(() => {
          // If even the error notice can't be delivered there is nothing left
          // to try; swallowing it keeps the 200 below intact.
        });
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
      { taskService, client: briefingClient, model: config.llm.model },
    );
    return result;
  });

  return app;
}
