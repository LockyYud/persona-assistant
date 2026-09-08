import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@persona/db";
import type { NotificationChannel, NotionClient, NotionPage } from "@persona/integrations";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { runTick } from "./tick.js";

const DATABASE_ID = "db-1";
const PAGE_ID = "page-1";
const CHAT_ID = "chat-1";

/** Records what the tick tried to deliver. */
function recordingChannel(): NotificationChannel & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send({ text }) {
      sent.push(text);
      return { providerMessageId: `msg-${sent.length}` };
    },
  };
}

/**
 * Serves the task's page as freshly edited, so the sync pass inside the tick
 * definitely processes it — and therefore definitely re-derives its reminders.
 */
function fakeNotion(page: NotionPage): NotionClient {
  return {
    queryDatabase: async () => ({ pages: [page], nextCursor: null }),
    updatePage: async () => ({ id: PAGE_ID, last_edited_time: new Date().toISOString() }),
    createPage: async () => ({ id: PAGE_ID, last_edited_time: new Date().toISOString() }),
  } as unknown as NotionClient;
}

describe("runTick and an already-owed reminder", () => {
  beforeEach(resetTestDb);

  it("delivers a reminder that fell due, even though the sync re-derives first", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    // Already past: this is a reminder the previous tick did not reach.
    const dueAt = new Date(Date.now() - 60 * 1000);

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        title: "Nộp báo cáo",
        priority: "medium",
        type: "work",
        dueAt,
        notionPageId: PAGE_ID,
      })
      .returning();

    await db.insert(schema.reminders).values({
      taskId: task!.id,
      userId,
      message: "Đến hạn: Nộp báo cáo",
      nextRunAt: dueAt,
      source: "auto",
      kind: "due",
    });

    const channel = recordingChannel();
    const page = {
      id: PAGE_ID,
      last_edited_time: new Date().toISOString(),
      properties: { Title: { type: "title", title: [{ plain_text: "Nộp báo cáo" }] } },
    } as unknown as NotionPage;

    const result = await runTick(
      db,
      channel,
      async () => CHAT_ID,
      fakeNotion(page),
      DATABASE_ID,
    );

    // The tick syncs Notion before it claims, so this reminder is re-derived
    // while still active and owed. Deleting it there would lose the message
    // for good: its moment has passed, so recomputing the offsets from dueAt
    // cannot bring it back.
    expect(result.claimedReminders).toBe(1);
    expect(channel.sent).toEqual(["Đến hạn: Nộp báo cáo"]);

    const [reminder] = await db
      .select()
      .from(schema.reminders)
      .where(eq(schema.reminders.taskId, task!.id));
    expect(reminder?.status).toBe("completed");
  });
});
