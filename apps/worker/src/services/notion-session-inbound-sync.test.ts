import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@persona/db";
import type { NotionClient, NotionPage } from "@persona/integrations";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import { syncNotionSessionsForUser } from "./notion-session-sync.js";

const DATABASE_ID = "sessions-db-1";
const TASK_PAGE = "task-page-1";

/** A Notion client that serves one fixed page list. Only queryDatabase is reached by an inbound sync. */
function fakeNotion(pages: NotionPage[]): NotionClient {
  return {
    queryDatabase: async () => ({ pages, nextCursor: null }),
  } as unknown as NotionClient;
}

function sessionPage(
  id: string,
  properties: NotionPage["properties"],
  lastEdited = "2026-09-07T10:00:00.000Z",
): NotionPage {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: lastEdited,
    properties: {
      Title: { type: "title", title: [{ plain_text: "" }] },
      Task: { relation: [{ id: TASK_PAGE }] },
      Date: { date: { start: "2026-09-07" } },
      Planned: { number: 60 },
      ...properties,
    },
  } as unknown as NotionPage;
}

async function seedTask(userId: string, notionPageId: string | null = TASK_PAGE, title = "Học tiếng Anh") {
  const [task] = await getTestDb()
    .insert(schema.tasks)
    .values({ userId, title, priority: "medium", type: "personal", notionPageId })
    .returning();
  if (!task) throw new Error("failed to seed task");
  return task;
}

async function sessionByNotionPage(notionPageId: string) {
  const [row] = await getTestDb()
    .select()
    .from(schema.workSessions)
    .where(eq(schema.workSessions.notionPageId, notionPageId));
  return row ?? null;
}

async function seedPlannedSession(
  userId: string,
  taskId: string,
  overrides: Partial<typeof schema.workSessions.$inferInsert> = {},
) {
  const [row] = await getTestDb()
    .insert(schema.workSessions)
    .values({ userId, taskId, date: "2026-09-07", plannedMinutes: 60, ...overrides })
    .returning();
  if (!row) throw new Error("failed to seed session");
  return row;
}

describe("inbound Notion -> Postgres session sync", () => {
  beforeEach(resetTestDb);

  it("creates a planned Today item from a new Notion row", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    const result = await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Focus: { rich_text: [{ plain_text: "Run baseline" }] } })]),
      DATABASE_ID,
      userId,
    );

    expect(result.synced).toBe(1);
    const row = await sessionByNotionPage("page-1");
    expect(row?.status).toBe("planned");
    expect(row?.focusText).toBe("Run baseline");
    expect(row?.plannedMinutes).toBe(60);
  });

  it("revises an already-mapped session when its Notion row is edited", async () => {
    const userId = await createTestUser();
    const task = await seedTask(userId);
    await getTestDb()
      .insert(schema.workSessions)
      .values({ userId, taskId: task.id, date: "2026-09-07", plannedMinutes: 30, notionPageId: "page-1" });

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Planned: { number: 90 } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.plannedMinutes).toBe(90);
  });

  it("treats Title as the focus when Focus is blank and Title differs from the task", async () => {
    const userId = await createTestUser();
    await seedTask(userId, TASK_PAGE, "Học tiếng Anh");

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([
        sessionPage("page-1", { Title: { type: "title", title: [{ plain_text: "Ôn từ vựng" }] } }),
      ]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.focusText).toBe("Ôn từ vựng");
  });

  it("keeps a date-only row untimed", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Date: { date: { start: "2026-09-07" } } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.date).toBe("2026-09-07");
    expect(row?.startAt).toBeNull();
  });

  it("gives a Date+time row a startAt on the same local day", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Date: { date: { start: "2026-09-07T09:00:00.000+07:00" } } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.startAt).toEqual(new Date("2026-09-07T09:00:00.000+07:00"));
  });

  it("reorders Today items by Order", async () => {
    const userId = await createTestUser();
    const task = await seedTask(userId);
    const first = await seedPlannedSession(userId, task.id, { notionPageId: "page-1", position: 1 });
    await seedPlannedSession(userId, task.id, { notionPageId: "page-2", position: 2 });

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Order: { number: 5 } }, "2026-09-07T11:00:00.000Z")]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.position).toBe(5);
    expect(row?.id).toBe(first.id);
  });

  it("allows two Notion rows for the same task and day to become two sessions", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", {}), sessionPage("page-2", {}, "2026-09-07T11:00:00.000Z")]),
      DATABASE_ID,
      userId,
    );

    const rows = await getTestDb().select().from(schema.workSessions);
    expect(rows).toHaveLength(2);
  });

  it("cancels a planned session when Status is set to cancelled in Notion", async () => {
    const userId = await createTestUser();
    const task = await seedTask(userId);
    await seedPlannedSession(userId, task.id, { notionPageId: "page-1", actualMinutes: 10 });

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Status: { select: { name: "cancelled" } } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.status).toBe("cancelled");
    expect(row?.actualMinutes).toBeNull();
  });

  it("skips a row with no Task relation", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    const result = await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Task: { relation: [] } })]),
      DATABASE_ID,
      userId,
    );

    expect(result.synced).toBe(0);
    expect(await sessionByNotionPage("page-1")).toBeNull();
  });

  it("skips a row with an invalid (zero or missing) Planned duration", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    const result = await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Planned: { number: 0 } })]),
      DATABASE_ID,
      userId,
    );

    expect(result.synced).toBe(0);
    expect(await sessionByNotionPage("page-1")).toBeNull();
  });

  it("does not create an orphan session when the task hasn't synced in yet", async () => {
    const userId = await createTestUser();
    // No task seeded with TASK_PAGE at all.

    const result = await syncNotionSessionsForUser(getTestDb(), fakeNotion([sessionPage("page-1", {})]), DATABASE_ID, userId);

    expect(result.synced).toBe(0);
    expect(await sessionByNotionPage("page-1")).toBeNull();
  });

  it("refuses to reopen a session the app already marked done", async () => {
    const userId = await createTestUser();
    const task = await seedTask(userId);
    await seedPlannedSession(userId, task.id, {
      notionPageId: "page-1",
      status: "done",
      actualMinutes: 60,
    });

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Status: { select: { name: "planned" } } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.status).toBe("done");
    expect(row?.actualMinutes).toBe(60);
  });

  it("does not touch updatedAt when the Notion row already matches Postgres (echo suppression)", async () => {
    const userId = await createTestUser();
    const task = await seedTask(userId);
    const seeded = await seedPlannedSession(userId, task.id, {
      notionPageId: "page-1",
      plannedMinutes: 60,
      position: 1,
    });

    await syncNotionSessionsForUser(
      getTestDb(),
      fakeNotion([sessionPage("page-1", { Order: { number: 1 } })]),
      DATABASE_ID,
      userId,
    );

    const row = await sessionByNotionPage("page-1");
    expect(row?.updatedAt).toEqual(seeded.updatedAt);
  });

  it("advances the sessions cursor independently of the tasks cursor", async () => {
    const userId = await createTestUser();
    await seedTask(userId);

    await syncNotionSessionsForUser(getTestDb(), fakeNotion([sessionPage("page-1", {})]), DATABASE_ID, userId);

    const [user] = await getTestDb()
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, userId)));
    expect(user?.notionSessionsSyncCursor).toEqual(new Date("2026-09-07T10:00:00.000Z"));
    expect(user?.notionSyncCursor).toBeNull();
  });
});
