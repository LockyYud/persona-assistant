import { aliasedTable, and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient, NotionPage } from "@persona/integrations";
import type { Task, TaskPriority, TaskStatus, TaskType } from "@persona/core";
import { deriveTaskReminders } from "./reminder-derivation.js";

// Self-join alias: parents are `schema.tasks`, their steps are `subtasks`.
const subtasks = aliasedTable(schema.tasks, "subtasks");

/**
 * Expected Notion database schema (property name -> type). Task title lives
 * in whichever property is of type "title" (Notion requires exactly one);
 * the rest must match these names exactly.
 */
const STATUS_VALUES: readonly TaskStatus[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITY_VALUES: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];
const TYPE_VALUES: readonly TaskType[] = ["work", "personal", "chore"];

interface NotionTaskFields {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  dueAt: Date | null;
  /** Notion page id of this page's parent task, from the "Parent" relation. */
  parentNotionPageId: string | null;
}

interface NotionProperty {
  type?: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  date?: { start: string } | null;
  relation?: Array<{ id: string }>;
  number?: number | null;
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

function isTaskType(value: string | undefined): value is TaskType {
  return TYPE_VALUES.includes(value as TaskType);
}

/** Reads task fields out of a raw Notion page's properties. */
export function notionPageToTaskFields(page: NotionPage): NotionTaskFields {
  const properties = page.properties as Record<string, NotionProperty>;
  const titleProp = Object.values(properties).find((p) => p?.type === "title");

  const statusName = properties.Status?.select?.name;
  const priorityName = properties.Priority?.select?.name;
  const typeName = properties.Type?.select?.name;
  const description = properties.Description?.rich_text;
  const due = properties.Due?.date?.start;

  return {
    title: plainText(titleProp?.title) || "(untitled)",
    description: description?.length ? plainText(description) : null,
    status: isTaskStatus(statusName) ? statusName : "open",
    priority: isTaskPriority(priorityName) ? priorityName : "medium",
    type: isTaskType(typeName) ? typeName : "personal",
    dueAt: due ? new Date(due) : null,
    // A page can relate to several others, but a task has exactly one
    // parent — take the first and ignore the rest.
    parentNotionPageId: properties.Parent?.relation?.[0]?.id ?? null,
  };
}

/**
 * Builds the Notion property payload to mirror a task onto its page.
 *
 * `parentNotionPageId` has to be passed in rather than read off the task,
 * because a task stores its parent as our own uuid and Notion needs that
 * parent's *page* id. Progress is deliberately absent: it's derived from
 * child rows and written separately (see pushProgressToNotion) so that a
 * plain task edit doesn't have to know anything about its steps.
 */
export function taskToNotionProperties(
  task: Task,
  parentNotionPageId?: string | null,
): Record<string, unknown> {
  return {
    Title: { title: [{ text: { content: task.title } }] },
    Description: { rich_text: task.description ? [{ text: { content: task.description } }] : [] },
    Status: { select: { name: task.status } },
    Priority: { select: { name: task.priority } },
    Type: { select: { name: task.type } },
    Due: { date: task.dueAt ? { start: task.dueAt.toISOString() } : null },
    Parent: { relation: parentNotionPageId ? [{ id: parentNotionPageId }] : [] },
  };
}

/** Formats step counts the way the guard column stores them. */
function progressKey(done: number, total: number): string {
  return `${done}/${total}`;
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
    // A step's parent must already exist in Notion for the relation to point
    // anywhere; if it hasn't been mirrored yet the link is simply left off and
    // the next inbound sync fills it in.
    let parentNotionPageId: string | null = null;
    if (task.parentTaskId) {
      const [parent] = await db
        .select({ notionPageId: schema.tasks.notionPageId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.parentTaskId));
      parentNotionPageId = parent?.notionPageId ?? null;
    }

    const properties = taskToNotionProperties(task, parentNotionPageId);

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
 * Writes the derived step progress onto the Notion pages of every parent task
 * that has steps, so the counts show up in Notion's own table/board views
 * rather than only in this app.
 *
 * Notion has no rollup that can count children by select value, so the number
 * has to be computed here and pushed. Each push bumps the page's
 * last_edited_time, which would drag the page back into the next sync pass
 * forever — hence the notionProgressPushed guard: a page is only written when
 * its counts actually changed since the last write.
 */
export async function pushProgressToNotion(
  db: Database,
  notion: NotionClient,
  userId: string,
): Promise<{ pushed: number }> {
  const parents = await db
    .select({
      id: schema.tasks.id,
      notionPageId: schema.tasks.notionPageId,
      pushed: schema.tasks.notionProgressPushed,
      total: sql<number>`count(${subtasks.id})::int`,
      done: sql<number>`count(*) filter (where ${subtasks.status} = 'done')::int`,
    })
    .from(schema.tasks)
    .innerJoin(
      subtasks,
      and(eq(subtasks.parentTaskId, schema.tasks.id), ne(subtasks.status, "cancelled")),
    )
    .where(and(eq(schema.tasks.userId, userId), isNotNull(schema.tasks.notionPageId)))
    .groupBy(schema.tasks.id, schema.tasks.notionPageId, schema.tasks.notionProgressPushed);

  let pushed = 0;

  for (const parent of parents) {
    const key = progressKey(parent.done, parent.total);
    if (parent.pushed === key || !parent.notionPageId || parent.total === 0) continue;

    // Notion's "percent" number format renders a 0..1 fraction as 0..100%.
    const result = await notion.updatePage(parent.notionPageId, {
      Progress: { number: Number((parent.done / parent.total).toFixed(4)) },
    });

    if ("error" in result) {
      console.error(`Failed to push progress for task ${parent.id}:`, result.error);
      continue;
    }

    await db
      .update(schema.tasks)
      .set({ notionProgressPushed: key, notionSyncedAt: new Date(result.last_edited_time) })
      .where(eq(schema.tasks.id, parent.id));
    pushed += 1;
  }

  return { pushed };
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
  const pendingParentLinks = new Map<string, string>();
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
      // Parent links are resolved after the whole batch: a step's page can be
      // applied before the parent page it points at exists in Postgres, so
      // the relation can only be turned into a parentTaskId once every page
      // in this pass has a row.
      const parentPageId = notionPageToTaskFields(notionPage).parentNotionPageId;
      if (parentPageId) pendingParentLinks.set(notionPage.id, parentPageId);
      synced += 1;
    }

    if (done || !page.nextCursor) break;
    startCursor = page.nextCursor;
  }

  await resolveParentLinks(db, userId, pendingParentLinks);

  if (newestSeen) {
    await db
      .update(schema.users)
      .set({ notionSyncCursor: newestSeen })
      .where(eq(schema.users.id, userId));
  }

  return { synced };
}

/**
 * Turns "child page -> parent page" links into parentTaskId values, once both
 * sides are guaranteed to have rows. A link whose parent page isn't in the
 * database (deleted, or not shared with the integration) is skipped rather
 * than clearing an existing parent.
 */
async function resolveParentLinks(
  db: Database,
  userId: string,
  links: Map<string, string>,
): Promise<void> {
  if (links.size === 0) return;

  const pageIds = [...new Set([...links.keys(), ...links.values()])];
  const rows = await db
    .select({ id: schema.tasks.id, notionPageId: schema.tasks.notionPageId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.userId, userId), inArray(schema.tasks.notionPageId, pageIds)));

  const taskIdByPage = new Map(rows.filter((r) => r.notionPageId).map((r) => [r.notionPageId!, r.id]));

  for (const [childPageId, parentPageId] of links) {
    const childId = taskIdByPage.get(childPageId);
    const parentId = taskIdByPage.get(parentPageId);
    // Guard against a page related to itself, which would create a cycle.
    if (!childId || !parentId || childId === parentId) continue;

    await db
      .update(schema.tasks)
      .set({ parentTaskId: parentId })
      .where(eq(schema.tasks.id, childId));
  }
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
            type: fields.type,
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
            type: fields.type,
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
      type: row.type,
      dueAt: row.dueAt,
      parentTaskId: row.parentTaskId,
      notionPageId: row.notionPageId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    await deriveTaskReminders(tx, task);
  });
}
