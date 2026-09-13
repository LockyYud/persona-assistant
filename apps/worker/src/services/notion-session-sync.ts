import { eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient } from "@persona/integrations";
import type { WorkSession } from "@persona/core";
import { formatMinutes } from "./pace.js";

/**
 * Sessions are mirrored to Notion in ONE direction only, app -> Notion.
 *
 * The task sync is two-way because Notion's UI is where tasks get edited. A
 * session is different: it is created from the widget or in chat, in the same
 * breath as deciding to do it, so there is nothing to read back. Skipping the
 * inbound half avoids a whole mechanism — no sync cursor for this database, no
 * revive-versus-delete question when a page disappears, and no risk of an
 * edit loop.
 *
 * For the same reason nothing here writes a routine's pace onto Notion. Pace
 * changes every day, and every write bumps a page's last_edited_time; the
 * `notionProgressPushed` guard exists because of exactly that problem on the
 * task side. Pace is read in the widget, in chat and in the morning briefing
 * instead.
 */
export function sessionToNotionProperties(
  session: WorkSession,
  taskTitle: string,
  taskNotionPageId: string | null,
): Record<string, unknown> {
  // A timed session becomes a real block on the calendar, so it needs an end;
  // an untimed one is an all-day item, which is what a bare date renders as.
  const date = session.startAt
    ? {
        start: session.startAt.toISOString(),
        end: new Date(session.startAt.getTime() + session.plannedMinutes * 60_000).toISOString(),
      }
    : { start: session.date };

  return {
    // The duration rides in the title because that is all a calendar block
    // shows at a glance.
    Title: {
      title: [
        {
          text: {
            content: [taskTitle, session.focusText, formatMinutes(session.plannedMinutes)]
              .filter(Boolean)
              .join(" · "),
          },
        },
      ],
    },
    Task: { relation: taskNotionPageId ? [{ id: taskNotionPageId }] : [] },
    Date: { date },
    Planned: { number: session.plannedMinutes },
    Actual: { number: session.actualMinutes },
    Status: { select: { name: session.status } },
  };
}

/**
 * Best-effort push of one session to Notion, creating its page on first sync
 * and updating it afterwards.
 *
 * Failures are logged and swallowed, never rolled back: Postgres is the
 * source of truth for pace and for anything transactional, and losing the
 * mirror of one day costs a calendar entry rather than the record of the work.
 */
export async function pushSessionToNotion(
  db: Database,
  notion: NotionClient,
  databaseId: string,
  session: WorkSession,
): Promise<WorkSession> {
  try {
    const [task] = await db
      .select({ title: schema.tasks.title, notionPageId: schema.tasks.notionPageId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, session.taskId));
    if (!task) return session;

    // If the task itself has not been mirrored yet the relation is simply left
    // empty; the session page is still worth creating, and a later write once
    // the task has a page will fill the link in.
    const properties = sessionToNotionProperties(session, task.title, task.notionPageId);

    if (session.notionPageId) {
      const result = await notion.updatePage(session.notionPageId, properties);
      if ("error" in result) throw new Error(result.error);
      await db
        .update(schema.workSessions)
        .set({ notionSyncedAt: new Date(result.last_edited_time) })
        .where(eq(schema.workSessions.id, session.id));
      return session;
    }

    const result = await notion.createPage(databaseId, properties);
    if ("error" in result) throw new Error(result.error);
    await db
      .update(schema.workSessions)
      .set({ notionPageId: result.id, notionSyncedAt: new Date(result.last_edited_time) })
      .where(eq(schema.workSessions.id, session.id));
    return { ...session, notionPageId: result.id };
  } catch (error) {
    console.error(`Failed to push session ${session.id} to Notion:`, error);
    return session;
  }
}
