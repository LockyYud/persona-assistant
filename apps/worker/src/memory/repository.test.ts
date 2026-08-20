import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@persona/db";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { createConversation, loadRecentMessages } from "./repository.js";

/**
 * Inserts with an explicit createdAt so ordering is deterministic —
 * appendMessage always uses now(), which can't reliably distinguish rows
 * inserted within the same millisecond.
 */
async function insertRaw(
  conversationId: string,
  userId: string,
  row: { role: "user" | "assistant" | "tool"; content: string | null; toolCalls?: unknown; toolCallId?: string },
  createdAt: Date,
) {
  await getTestDb()
    .insert(schema.conversationMessages)
    .values({
      conversationId,
      userId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls ?? null,
      toolCallId: row.toolCallId ?? null,
      createdAt,
    });
}

describe("loadRecentMessages", () => {
  beforeEach(resetTestDb);

  it("drops a leading orphaned tool message whose tool_calls assistant fell outside the window", async () => {
    const userId = await createTestUser();
    // conversation_messages is FK'd to conversations, so the thread has to
    // exist before anything can be appended to it.
    const conversationId = await createConversation(getTestDb(), userId, "web");
    const base = new Date("2026-08-19T00:00:00.000Z");
    const at = (offsetMs: number) => new Date(base.getTime() + offsetMs);

    // Assistant + its tool response fall outside a limit=2 window; the
    // trailing user/assistant pair is what should survive.
    await insertRaw(
      conversationId,
      userId,
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", type: "function", function: { name: "listTasks", arguments: "{}" } }] },
      at(0),
    );
    await insertRaw(conversationId, userId, { role: "tool", content: "[]", toolCallId: "call_1" }, at(1));
    await insertRaw(conversationId, userId, { role: "user", content: "thanks" }, at(2));
    await insertRaw(conversationId, userId, { role: "assistant", content: "You're welcome!" }, at(3));

    const messages = await loadRecentMessages(getTestDb(), conversationId, 2);

    expect(messages).toEqual([
      { role: "user", content: "thanks" },
      { role: "assistant", content: "You're welcome!", tool_calls: undefined },
    ]);
  });

  it("keeps a complete tool_calls/tool pair when both are inside the window", async () => {
    const userId = await createTestUser();
    // conversation_messages is FK'd to conversations, so the thread has to
    // exist before anything can be appended to it.
    const conversationId = await createConversation(getTestDb(), userId, "web");
    const base = new Date("2026-08-19T00:00:00.000Z");
    const at = (offsetMs: number) => new Date(base.getTime() + offsetMs);

    await insertRaw(conversationId, userId, { role: "user", content: "check my tasks" }, at(0));
    await insertRaw(
      conversationId,
      userId,
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", type: "function", function: { name: "listTasks", arguments: "{}" } }] },
      at(1),
    );
    await insertRaw(conversationId, userId, { role: "tool", content: "[]", toolCallId: "call_1" }, at(2));

    const messages = await loadRecentMessages(getTestDb(), conversationId, 3);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});
