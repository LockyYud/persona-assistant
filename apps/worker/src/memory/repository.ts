import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";

export type StoredMessageRole = "user" | "assistant" | "tool";
export type ConversationChannel = "web" | "telegram";

export async function createConversation(
  db: Database,
  userId: string,
  channel: ConversationChannel,
): Promise<string> {
  const [row] = await db
    .insert(schema.conversations)
    .values({ userId, channel })
    .returning({ id: schema.conversations.id });

  if (!row) throw new Error("Failed to create conversation");
  return row.id;
}

/**
 * Decides which thread a new message joins.
 *
 * An explicit id wins, but only if it really belongs to this user — the id
 * arrives from a client, so trusting it blindly would let one account append
 * to another's thread.
 *
 * Otherwise the caller is saying "continue where I left off", and the answer
 * is scoped to the channel: Telegram continues the latest Telegram thread and
 * the web app the latest web one. Without that scoping, sending a Telegram
 * message would land in whatever thread the web app happened to use last.
 */
export async function resolveConversationId(
  db: Database,
  userId: string,
  options: {
    conversationId?: string;
    channel: ConversationChannel;
    startNew?: boolean;
  },
): Promise<string> {
  if (options.startNew) return createConversation(db, userId, options.channel);

  if (options.conversationId) {
    const [owned] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, options.conversationId),
          eq(schema.conversations.userId, userId),
        ),
      );
    if (owned) return owned.id;
    // An unknown or someone else's id is treated as "start fresh" rather than
    // an error: the caller still gets a working thread, and the real id comes
    // back in the response.
    return createConversation(db, userId, options.channel);
  }

  const [latest] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.userId, userId), eq(schema.conversations.channel, options.channel)),
    )
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(1);

  return latest?.id ?? createConversation(db, userId, options.channel);
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  channel: ConversationChannel;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Threads for the sidebar, most recent first. Empty ones are left out: both
 * "New chat" and Telegram's /new create a thread before there's anything in
 * it, and an empty row in the list is just noise.
 */
export async function listConversations(
  db: Database,
  userId: string,
  limit = 50,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      channel: schema.conversations.channel,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt,
      messageCount: sql<number>`count(${schema.conversationMessages.id})::int`,
    })
    .from(schema.conversations)
    .leftJoin(
      schema.conversationMessages,
      eq(schema.conversationMessages.conversationId, schema.conversations.id),
    )
    .where(eq(schema.conversations.userId, userId))
    .groupBy(
      schema.conversations.id,
      schema.conversations.title,
      schema.conversations.channel,
      schema.conversations.createdAt,
      schema.conversations.updatedAt,
    )
    .having(sql`count(${schema.conversationMessages.id}) > 0`)
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(limit);

  return rows;
}

export interface ConversationTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/**
 * A thread's history for replaying it in the UI, oldest first. Tool traffic is
 * left out — it's part of how an answer was produced, not part of the
 * conversation as the user experienced it. Assistant turns whose only content
 * was a tool call have nothing to show and are dropped too.
 *
 * Returns null when the thread isn't this user's, so the caller can 404
 * instead of leaking whether the id exists.
 */
export async function loadConversationTranscript(
  db: Database,
  userId: string,
  conversationId: string,
): Promise<ConversationTranscriptMessage[] | null> {
  const [conversation] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, conversationId), eq(schema.conversations.userId, userId)),
    );
  if (!conversation) return null;

  const rows = await db
    .select()
    .from(schema.conversationMessages)
    .where(eq(schema.conversationMessages.conversationId, conversationId))
    .orderBy(schema.conversationMessages.createdAt);

  return rows
    .filter(
      (row): row is typeof row & { content: string } =>
        (row.role === "user" || row.role === "assistant") && !!row.content?.trim(),
    )
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
      createdAt: row.createdAt,
    }));
}

/** Bumps last-activity so the thread list and channel lookup stay ordered by use. */
export async function touchConversation(db: Database, conversationId: string): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversationId));
}

/** Sets a thread's title, but never overwrites one it already has. */
export async function setConversationTitleIfEmpty(
  db: Database,
  conversationId: string,
  title: string,
): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ title })
    .where(and(eq(schema.conversations.id, conversationId), sql`${schema.conversations.title} is null`));
}

const MESSAGE_WINDOW = 20;

export async function loadRecentMessages(
  db: Database,
  conversationId: string,
  limit = MESSAGE_WINDOW,
): Promise<ChatCompletionMessageParam[]> {
  const rows = await db
    .select()
    .from(schema.conversationMessages)
    .where(eq(schema.conversationMessages.conversationId, conversationId))
    .orderBy(desc(schema.conversationMessages.createdAt))
    .limit(limit);

  const chronological = rows.reverse();
  // The window can start mid tool-call sequence, cutting off the assistant
  // message whose tool_calls a leading "tool" row answers — the OpenAI API
  // rejects a "tool" message with no preceding tool_calls in the same
  // request, so any such orphans must be dropped before they reach it.
  while (chronological[0]?.role === "tool") chronological.shift();

  return chronological.map((row): ChatCompletionMessageParam => {
    if (row.role === "tool") {
      return {
        role: "tool",
        tool_call_id: row.toolCallId ?? "",
        content: row.content ?? "",
      };
    }
    if (row.role === "assistant") {
      return {
        role: "assistant",
        content: row.content,
        tool_calls: (row.toolCalls as never) ?? undefined,
      };
    }
    return { role: "user", content: row.content ?? "" };
  });
}

export async function appendMessage(
  db: Database,
  params: {
    conversationId: string;
    userId: string;
    role: StoredMessageRole;
    content: string | null;
    toolCalls?: unknown;
    toolCallId?: string;
  },
): Promise<void> {
  await db.insert(schema.conversationMessages).values({
    conversationId: params.conversationId,
    userId: params.userId,
    role: params.role,
    content: params.content,
    toolCalls: params.toolCalls ?? null,
    toolCallId: params.toolCallId ?? null,
  });
}

const MEMORY_LIMIT = 20;

export async function loadTopMemories(
  db: Database,
  userId: string,
  limit = MEMORY_LIMIT,
): Promise<(typeof schema.memories.$inferSelect)[]> {
  return db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.userId, userId))
    .orderBy(desc(schema.memories.importance), desc(schema.memories.lastUsedAt))
    .limit(limit);
}

export async function listMemoryKeys(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: schema.memories.key })
    .from(schema.memories)
    .where(eq(schema.memories.userId, userId));

  return rows.map((row) => row.key);
}

export async function touchMemoriesLastUsed(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(schema.memories)
    .set({ lastUsedAt: new Date() })
    .where(inArray(schema.memories.id, ids));
}

export interface MemoryCandidate {
  type: "preference" | "fact" | "episodic";
  key: string;
  content: string;
  importance: number;
  confidence: number;
}

export async function upsertMemory(
  db: Database,
  userId: string,
  candidate: MemoryCandidate,
  source: string,
): Promise<void> {
  await db
    .insert(schema.memories)
    .values({
      userId,
      type: candidate.type,
      key: candidate.key,
      content: candidate.content,
      importance: candidate.importance,
      confidence: candidate.confidence,
      source,
    })
    .onConflictDoUpdate({
      target: [schema.memories.userId, schema.memories.key],
      set: {
        type: candidate.type,
        content: candidate.content,
        importance: candidate.importance,
        confidence: candidate.confidence,
        source,
        updatedAt: new Date(),
      },
    });
}

export async function getPendingApproval(
  db: Database,
  userId: string,
): Promise<(typeof schema.approvalRequests.$inferSelect) | null> {
  const [row] = await db
    .select()
    .from(schema.approvalRequests)
    .where(
      and(eq(schema.approvalRequests.userId, userId), eq(schema.approvalRequests.status, "pending")),
    )
    .orderBy(desc(schema.approvalRequests.createdAt))
    .limit(1);

  return row ?? null;
}
