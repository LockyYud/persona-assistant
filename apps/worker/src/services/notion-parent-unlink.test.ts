import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@persona/db";
import type { NotionClient, NotionPage } from "@persona/integrations";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { syncNotionTasksForUser } from "./notion-sync.js";

const DATABASE_ID = "db-1";
const PARENT_PAGE = "parent-page";
const CHILD_PAGE = "child-page";

/**
 * A Notion client that serves one fixed page. Only queryDatabase is reached by
 * an inbound sync, so the rest is left unimplemented rather than stubbed into
 * looking usable.
 */
function fakeNotion(pages: NotionPage[]): NotionClient {
  return {
    queryDatabase: async () => ({ pages, nextCursor: null }),
  } as unknown as NotionClient;
}

function childPage(properties: NotionPage["properties"]): NotionPage {
  return {
    id: CHILD_PAGE,
    last_edited_time: "2026-09-08T10:00:00.000Z",
    properties: {
      Title: { type: "title", title: [{ plain_text: "A step" }] },
      ...properties,
    },
  } as unknown as NotionPage;
}

/** Seeds a parent and a step already linked to it, and returns the step's id. */
async function seedLinkedPair(userId: string, parentNotionPageId: string | null) {
  const db = getTestDb();
  const [parent] = await db
    .insert(schema.tasks)
    .values({
      userId,
      title: "Vlog",
      priority: "high",
      type: "personal",
      notionPageId: parentNotionPageId,
    })
    .returning();
  const [child] = await db
    .insert(schema.tasks)
    .values({
      userId,
      title: "A step",
      priority: "medium",
      type: "personal",
      notionPageId: CHILD_PAGE,
      parentTaskId: parent!.id,
    })
    .returning();
  return child!.id;
}

async function parentOf(taskId: string): Promise<string | null> {
  const [row] = await getTestDb()
    .select({ parentTaskId: schema.tasks.parentTaskId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  return row?.parentTaskId ?? null;
}

describe("unlinking a step in Notion", () => {
  beforeEach(resetTestDb);

  it("clears the local parent when the sub-item relation comes back empty", async () => {
    const userId = await createTestUser();
    const childId = await seedLinkedPair(userId, PARENT_PAGE);

    await syncNotionTasksForUser(
      getTestDb(),
      fakeNotion([childPage({ "Parent item": { relation: [] } })]),
      DATABASE_ID,
      userId,
    );

    // Dragging a step out of the tree in Notion is the whole point of the
    // empty relation, so it has to reach Postgres.
    expect(await parentOf(childId)).toBeNull();
  });

  it("keeps the local parent when the parent has no Notion page yet", async () => {
    const userId = await createTestUser();
    const childId = await seedLinkedPair(userId, null);

    await syncNotionTasksForUser(
      getTestDb(),
      fakeNotion([childPage({ "Parent item": { relation: [] } })]),
      DATABASE_ID,
      userId,
    );

    // pushTaskToNotion writes the relation empty when the parent hasn't been
    // mirrored yet. Reading that placeholder as a removal would dismantle a
    // breakdown the app created seconds earlier.
    expect(await parentOf(childId)).not.toBeNull();
  });

  it("keeps the local parent when the property is absent from the database", async () => {
    const userId = await createTestUser();
    const childId = await seedLinkedPair(userId, PARENT_PAGE);

    await syncNotionTasksForUser(getTestDb(), fakeNotion([childPage({})]), DATABASE_ID, userId);

    // A workspace that never turned Sub-items on must not have every
    // breakdown flattened on its first sync pass.
    expect(await parentOf(childId)).not.toBeNull();
  });

  it("still links a step whose relation points at a parent page", async () => {
    const userId = await createTestUser();
    const db = getTestDb();
    const [parent] = await db
      .insert(schema.tasks)
      .values({
        userId,
        title: "Vlog",
        priority: "high",
        type: "personal",
        notionPageId: PARENT_PAGE,
      })
      .returning();
    const [child] = await db
      .insert(schema.tasks)
      .values({
        userId,
        title: "A step",
        priority: "medium",
        type: "personal",
        notionPageId: CHILD_PAGE,
      })
      .returning();

    await syncNotionTasksForUser(
      getTestDb(),
      fakeNotion([childPage({ "Parent item": { relation: [{ id: PARENT_PAGE }] } })]),
      DATABASE_ID,
      userId,
    );

    expect(await parentOf(child!.id)).toBe(parent!.id);
  });
});
