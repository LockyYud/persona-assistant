import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@persona/db";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import {
  appendMessage,
  createConversation,
  listConversations,
  loadConversationTranscript,
  resolveConversationId,
  setConversationTitleIfEmpty,
  touchConversation,
} from "./repository.js";

async function seedTurn(conversationId: string, userId: string, text: string) {
  await appendMessage(getTestDb(), { conversationId, userId, role: "user", content: text });
  await appendMessage(getTestDb(), { conversationId, userId, role: "assistant", content: `re: ${text}` });
}

describe("resolveConversationId", () => {
  beforeEach(resetTestDb);

  it("continues the latest thread of the SAME channel, not the other one", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const webThread = await createConversation(db, userId, "web");
    const telegramThread = await createConversation(db, userId, "telegram");
    // The web thread is used most recently overall...
    await touchConversation(db, webThread);

    // ...but a Telegram message must still land in the Telegram thread. This
    // is the bleed that used to send Telegram messages into the web thread.
    const forTelegram = await resolveConversationId(db, userId, { channel: "telegram" });
    expect(forTelegram).toBe(telegramThread);

    const forWeb = await resolveConversationId(db, userId, { channel: "web" });
    expect(forWeb).toBe(webThread);
  });

  it("starts a fresh thread when startNew is set, even with a usable one available", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    const existing = await createConversation(db, userId, "web");

    const resolved = await resolveConversationId(db, userId, { channel: "web", startNew: true });

    expect(resolved).not.toBe(existing);
  });

  it("creates the first thread when the user has none on that channel", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const resolved = await resolveConversationId(db, userId, { channel: "telegram" });

    const [row] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, resolved));
    expect(row?.channel).toBe("telegram");
  });

  it("honours an explicit id that belongs to the user", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    const older = await createConversation(db, userId, "web");
    const newer = await createConversation(db, userId, "web");
    await touchConversation(db, newer);

    // Explicit id wins over "most recent".
    const resolved = await resolveConversationId(db, userId, {
      channel: "web",
      conversationId: older,
    });
    expect(resolved).toBe(older);
  });

  it("refuses another user's thread id instead of appending to it", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const db = getTestDb();
    const ownersThread = await createConversation(db, owner, "web");

    const resolved = await resolveConversationId(db, attacker, {
      channel: "web",
      conversationId: ownersThread,
    });

    // The id arrives from a client, so it must never be trusted as-is.
    expect(resolved).not.toBe(ownersThread);
  });

  it("falls back to a new thread for an id that doesn't exist", async () => {
    const userId = await createTestUser();
    const resolved = await resolveConversationId(getTestDb(), userId, {
      channel: "web",
      conversationId: randomUUID(),
    });
    expect(resolved).toBeTruthy();
  });
});

describe("listConversations", () => {
  beforeEach(resetTestDb);

  it("hides threads with no messages and orders the rest by last activity", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const first = await createConversation(db, userId, "web");
    await seedTurn(first, userId, "thread one");
    const second = await createConversation(db, userId, "telegram");
    await seedTurn(second, userId, "thread two");
    // "New chat" and Telegram's /new both create a thread before anything is
    // in it; an empty row in the sidebar is just noise.
    await createConversation(db, userId, "web");

    await touchConversation(db, second);
    await touchConversation(db, first);

    const listed = await listConversations(db, userId);

    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe(first);
    expect(listed[1]?.id).toBe(second);
    expect(listed[1]?.channel).toBe("telegram");
    expect(listed[0]?.messageCount).toBe(2);
  });

  it("never lists another user's threads", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const db = getTestDb();
    const theirThread = await createConversation(db, theirs, "web");
    await seedTurn(theirThread, theirs, "not yours");

    expect(await listConversations(db, mine)).toHaveLength(0);
  });
});

describe("loadConversationTranscript", () => {
  beforeEach(resetTestDb);

  it("returns user and assistant turns in order, leaving out tool traffic", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    const conversationId = await createConversation(db, userId, "web");

    await appendMessage(db, { conversationId, userId, role: "user", content: "check my tasks" });
    // An assistant turn that only called a tool has nothing to show, and the
    // tool result is how the answer was produced, not part of the dialogue.
    await appendMessage(db, {
      conversationId,
      userId,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_1", type: "function", function: { name: "listTasks", arguments: "{}" } }],
    });
    await appendMessage(db, { conversationId, userId, role: "tool", content: "[]", toolCallId: "call_1" });
    await appendMessage(db, { conversationId, userId, role: "assistant", content: "You have none." });

    const transcript = await loadConversationTranscript(db, userId, conversationId);

    expect(transcript).toEqual([
      expect.objectContaining({ role: "user", content: "check my tasks" }),
      expect.objectContaining({ role: "assistant", content: "You have none." }),
    ]);
  });

  it("returns null for a thread that isn't the user's, so the caller can 404", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const db = getTestDb();
    const conversationId = await createConversation(db, owner, "web");
    await seedTurn(conversationId, owner, "private");

    expect(await loadConversationTranscript(db, other, conversationId)).toBeNull();
  });
});

describe("setConversationTitleIfEmpty", () => {
  beforeEach(resetTestDb);

  it("sets a title once and never overwrites it afterwards", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    const conversationId = await createConversation(db, userId, "web");

    await setConversationTitleIfEmpty(db, conversationId, "Notion sync bug");
    await setConversationTitleIfEmpty(db, conversationId, "Something else");

    const [row] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    expect(row?.title).toBe("Notion sync bug");
  });
});
