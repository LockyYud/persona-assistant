import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient, NotionPage } from "@persona/integrations";
import type { Task, TaskPriority, TaskStatus } from "@persona/core";
import { deriveTaskReminders } from "./reminder-derivation.js";

/**
 * Expected Notion database schema (property name -> type). Task title lives
 * in whichever property is of type "title" (Notion requires exactly one);
 * the rest must match these names exactly.
 */
const STATUS_VALUES: readonly TaskStatus[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITY_VALUES: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

interface NotionTaskFields {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Date | null;
}

interface NotionProperty {
  type?: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  date?: { start: string } | null;
}

function plainText(richText: Array<{ plain_text: string }> | undefined): string {
  return (richText ?? []).map((t) => t.plain_text).join("");
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
  return STATUS_VALUES.includes(value as TaskStatus);
}

function isTaskPriority(value: string | undefined): value is TaskPriority {
  return PRIORITY_VALUES.includes(value as TaskPriority);
}

/** Reads task fields out of a raw Notion page's properties. */
export function notionPageToTaskFields(page: NotionPage): NotionTaskFields {
  const properties = page.properties as Record<string, NotionProperty>;
  const titleProp = Object.values(properties).find((p) => p?.type === "title");

  const statusName = properties.Status?.select?.name;
  const priorityName = properties.Priority?.select?.name;
  const description = properties.Description?.rich_text;
  const due = properties.Due?.date?.start;

  return {
    title: plainText(titleProp?.title) || "(untitled)",
    description: description?.length ? plainText(description) : null,
    status: isTaskStatus(statusName) ? statusName : "open",
    priority: isTaskPriority(priorityName) ? priorityName : "medium",
    dueAt: due ? new Date(due) : null,
  };
}

/** Builds the Notion property payload to mirror a task onto its page. */
export function taskToNotionProperties(task: Task): Record<string, unknown> {
  return {
    Title: { title: [{ text: { content: task.title } }] },
    Description: { rich_text: task.description ? [{ text: { content: task.description } }] : [] },
    Status: { select: { name: task.status } },
    Priority: { select: { name: task.priority } },
    Due: { date: task.dueAt ? { start: task.dueAt.toISOString() } : null },
  };
}

/**
 * Best-effort push of a task's current state to its Notion page — creating
 * the page on first sync, updating it afterwards. Postgres stays the
 * transactional source for reminders/scheduling, so failures here are
 * logged and swallowed rather than rolling back the task write: the next
 * inbound sync pass (or another local edit) will retry.
 */
export async function pushTaskToNotion(
  db: Database,
  notion: NotionClient,
  databaseId: string,
  task: Task,
): Promise<Task> {
  try {
    const properties = taskToNotionProperties(task);

    if (task.notionPageId) {
      const result = await notion.updatePage(task.notionPageId, properties);
      if ("error" in result) throw new Error(result.error);
      const notionSyncedAt = new Date(result.last_edited_time);
      await db.update(schema.tasks).set({ notionSyncedAt }).where(eq(schema.tasks.id, task.id));
      return task;
    }

    const result = await notion.createPage(databaseId, properties);
    if ("error" in result) throw new Error(result.error);
    const notionPageId = result.id;
    const notionSyncedAt = new Date(result.last_edited_time);
    await db.update(schema.tasks).set({ notionPageId, notionSyncedAt }).where(eq(schema.tasks.id, task.id));
    return { ...task, notionPageId };
  } catch (error) {
    console.error(`Failed to push task ${task.id} to Notion:`, error);
    return task;
  }
}

/**
 * Pulls whatever changed in the user's Notion database since their stored
 * cursor and mirrors it into Postgres — new pages become new tasks, edited
 * pages update their linked task, always re-deriving reminders in the same
 * transaction as the write (same as any other task mutation).
 *
 * Pages are fetched newest-edited-first and applied until one is reached
 * that's no newer than the stored cursor, so a pass only ever does as much
 * work as there is unsynced change.
 */
export async function syncNotionTasksForUser(
  db: Database,
  notion: NotionClient,
  databaseId: string,
  userId: string,
): Promise<{ synced: number }> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) return { synced: 0 };

  const cursor = user.notionSyncCursor;
  let synced = 0;
  let newestSeen: Date | null = null;
  let startCursor: string | undefined;
  let done = false;

  while (!done) {
    const page = await notion.queryDatabase(databaseId, { startCursor });
    if ("error" in page) {
      console.error(`Notion sync query failed for user ${userId}:`, page.error);
      break;
    }

    for (const notionPage of page.pages) {
      const lastEdited = new Date(notionPage.last_edited_time);
      if (cursor && lastEdited.getTime() <= cursor.getTime()) {
        done = true;
        break;
      }

      if (!newestSeen || lastEdited.getTime() > newestSeen.getTime()) newestSeen = lastEdited;
      await applyNotionPage(db, notionPage, userId, lastEdited);
      synced += 1;
    }

    if (done || !page.nextCursor) break;
    startCursor = page.nextCursor;
  }

  if (newestSeen) {
    await db
      .update(schema.users)
      .set({ notionSyncCursor: newestSeen })
      .where(eq(schema.users.id, userId));
  }

  return { synced };
}

async function applyNotionPage(
  db: Database,
  notionPage: NotionPage,
  userId: string,
  lastEdited: Date,
): Promise<void> {
  const fields = notionPageToTaskFields(notionPage);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.notionPageId, notionPage.id), eq(schema.tasks.userId, userId)));

    const [row] = existing
      ? await tx
          .update(schema.tasks)
          .set({
            title: fields.title,
            description: fields.description,
            status: fields.status,
            priority: fields.priority,
            dueAt: fields.dueAt,
            notionSyncedAt: lastEdited,
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, existing.id))
          .returning()
      : await tx
          .insert(schema.tasks)
          .values({
            userId,
            title: fields.title,
            description: fields.description,
            status: fields.status,
            priority: fields.priority,
            dueAt: fields.dueAt,
            notionPageId: notionPage.id,
            notionSyncedAt: lastEdited,
          })
          .returning();

    if (!row) throw new Error("Failed to upsert task from Notion page");

    const task: Task = {
      id: row.id,
      userId: row.userId,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      dueAt: row.dueAt,
      notionPageId: row.notionPageId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    await deriveTaskReminders(tx, task);
  });
}
