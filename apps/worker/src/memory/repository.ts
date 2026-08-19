import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";

export type StoredMessageRole = "user" | "assistant" | "tool";

/**
 * Resolves which conversation a new message belongs to. The web client
 * tracks its own conversationId across turns; channels that can't (Telegram)
 * omit it, so we reuse the user's most recently active conversation instead
 * of starting a fresh one on every message.
 */
export async function resolveConversationId(
  db: Database,
  userId: string,
  conversationId?: string,
): Promise<string> {
  if (conversationId) return conversationId;

  const [row] = await db
    .select({ conversationId: schema.conversationMessages.conversationId })
    .from(schema.conversationMessages)
    .where(eq(schema.conversationMessages.userId, userId))
    .orderBy(desc(schema.conversationMessages.createdAt))
    .limit(1);

  return row?.conversationId ?? randomUUID();
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
