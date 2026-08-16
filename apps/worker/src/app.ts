import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type Database } from "@persona/db";
import { TelegramNotificationChannel } from "@persona/integrations";
import { chatInputSchema, createTaskInputSchema, updateTaskInputSchema } from "@persona/core";
import { config } from "./config.js";
import { DrizzleTaskService } from "./services/task-service.js";
import { DrizzleReminderService } from "./services/reminder-service.js";
import { DeepSeekHarnessAdapter } from "./agent/deepseek-harness-adapter.js";
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
  const agentRuntime = new DeepSeekHarnessAdapter(
    db,
    taskService,
    reminderService,
    config.deepseekApiKey,
    config.deepseekModel,
  );
  const notificationChannel = new TelegramNotificationChannel(config.telegramBotToken);
  const resolveChatId = makeChatIdResolver(db);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/internal/") || request.url === "/health") return;

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
