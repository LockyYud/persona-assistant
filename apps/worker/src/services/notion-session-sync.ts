import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient, NotionPage } from "@persona/integrations";
import type { WorkSession, WorkSessionStatus } from "@persona/core";
import { cancelSessionReminder, syncSessionReminder } from "./session-reminders.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Sessions mirror to Notion in both directions: the app writes every
 * session-service mutation out (see DrizzleSessionService.syncToNotion
 * below), and the scheduler tick pulls edits back in (see
 * syncNotionSessionsForUser). This makes the Sessions database a real Today
 * Plan surface — a row can be created, reordered, retimed or cancelled from
 * Notion, not only mirrored for viewing.
 *
 * Inbound is restricted to `planned` sessions (see applyNotionSessionPage):
 * once a session is done/skipped/cancelled the app is authoritative and the
 * Notion row is history only, so an edit there — including flipping Status
 * back to "planned" — is ignored rather than reviving or mutating it.
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
    // Title is the field seen/typed day to day, so it carries whatever the
    // user is actually focusing on rather than an encoded "task · duration"
    // string — Planned already has the duration, and Focus below carries the
    // same text precisely for inbound parsing.
    Title: { title: [{ text: { content: session.focusText ?? taskTitle } }] },
    Focus: { rich_text: session.focusText ? [{ text: { content: session.focusText } }] : [] },
    Task: { relation: taskNotionPageId ? [{ id: taskNotionPageId }] : [] },
    Date: { date },
    Planned: { number: session.plannedMinutes },
    Actual: { number: session.actualMinutes },
    Order: { number: session.position },
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

const SESSION_STATUS_VALUES: readonly WorkSessionStatus[] = ["planned", "done", "skipped", "cancelled"];

function isSessionStatus(value: string | undefined): value is WorkSessionStatus {
  return SESSION_STATUS_VALUES.includes(value as WorkSessionStatus);
}

interface SessionProperty {
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

export interface NotionSessionFields {
  title: string;
  /** The Focus property, or null when it is blank. */
  focusText: string | null;
  taskNotionPageId: string | null;
  /** YYYY-MM-DD, or null when the Date property is empty. */
  date: string | null;
  /** Set only when the Date property itself carries a time, not just a day. */
  startAt: Date | null;
  /** Null when Planned is missing or not a number — an invalid row. */
  plannedMinutes: number | null;
  /** Null when Order is missing — the row goes wherever `nextPosition` says. */
  position: number | null;
  status: WorkSessionStatus;
}

/** Reads Today-item fields out of a raw Notion Sessions-database page. */
export function parseNotionSessionPage(page: NotionPage): NotionSessionFields {
  const properties = page.properties as Record<string, SessionProperty>;
  const titleProp = Object.values(properties).find((p) => p?.type === "title");
  const focusProp = properties.Focus?.rich_text;
  const start = properties.Date?.date?.start ?? null;
  const plannedRaw = properties.Planned?.number;
  const orderRaw = properties.Order?.number;
  const statusName = properties.Status?.select?.name;

  return {
    title: plainText(titleProp?.title),
    focusText: focusProp?.length ? plainText(focusProp) : null,
    taskNotionPageId: properties.Task?.relation?.[0]?.id ?? null,
    // A date-only value from Notion is "2026-09-07"; one with time on carries
    // a "T", e.g. "2026-09-07T09:00:00.000+07:00" — the first 10 characters
    // are the calendar day either way.
    date: start ? start.slice(0, 10) : null,
    startAt: start && start.includes("T") ? new Date(start) : null,
    plannedMinutes: typeof plannedRaw === "number" ? Math.round(plannedRaw) : null,
    position: typeof orderRaw === "number" ? Math.round(orderRaw) : null,
    status: isSessionStatus(statusName) ? statusName : "planned",
  };
}

/**
 * Resolves what a row's `focusText` should become, given the two fields a
 * person might have typed into: `Focus`, meant for this, and `Title`, kept
 * editable so a quick plan doesn't require touching both. Focus wins when
 * present; otherwise Title counts as the focus unless it is just the task's
 * own name, which means nobody typed anything distinguishing at all.
 */
export function resolveInboundFocusText(
  rawFocus: string | null,
  rawTitle: string,
  taskTitle: string,
): string | null {
  if (rawFocus) return rawFocus;
  const title = rawTitle.trim();
  if (!title || title === taskTitle) return null;
  return title;
}

/** Appends after the last Today item of the day when Notion supplied no Order. */
async function nextPosition(tx: Tx, userId: string, date: string): Promise<number> {
  const [last] = await tx
    .select({ position: schema.workSessions.position })
    .from(schema.workSessions)
    .where(and(eq(schema.workSessions.userId, userId), eq(schema.workSessions.date, date)))
    .orderBy(sql`${schema.workSessions.position} desc`)
    .limit(1);
  return (last?.position ?? 0) + 1;
}

/**
 * Applies one Notion Sessions-database page to Postgres — creating a new
 * planned Today item, revising an already-planned one, or doing nothing.
 *
 * `notionPageId` is the row's identity, never `(taskId, date)`: a task can
 * have more than one Today item on the same day, and two Notion rows for the
 * same task/day must become two sessions, not collide into one.
 *
 * Returns false for a row that was skipped — invalid, orphaned, or a
 * terminal-state edit refused — so the caller can report a count without
 * throwing over what is routine, expected input from a human-edited table.
 */
async function applyNotionSessionPage(
  db: Database,
  notionPage: NotionPage,
  userId: string,
  lastEdited: Date,
  timezone: string,
): Promise<boolean> {
  const fields = parseNotionSessionPage(notionPage);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.workSessions)
      .where(and(eq(schema.workSessions.notionPageId, notionPage.id), eq(schema.workSessions.userId, userId)));

    // Terminal states are app-authoritative; the Notion row is a history
    // mirror from here on, so an edit — including Status back to "planned" —
    // must not resurrect or mutate the session.
    if (existing && existing.status !== "planned") return false;

    if (!fields.taskNotionPageId) return false;
    const [task] = await tx
      .select({ id: schema.tasks.id, title: schema.tasks.title })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.notionPageId, fields.taskNotionPageId), eq(schema.tasks.userId, userId)));
    // The task hasn't synced in yet — skip rather than create an orphan; a
    // later pass (after the task exists) would still miss it since the
    // cursor has moved past this last_edited_time, same tradeoff the task
    // sync already accepts for blank rows.
    if (!task) return false;

    if (!fields.date || !fields.plannedMinutes || fields.plannedMinutes <= 0) return false;

    const focusText = resolveInboundFocusText(fields.focusText, fields.title, task.title);
    const status: WorkSessionStatus = fields.status === "cancelled" ? "cancelled" : "planned";

    if (existing) {
      const position = fields.position ?? existing.position;
      const startAt = fields.startAt;
      const changed =
        existing.taskId !== task.id ||
        existing.date !== fields.date ||
        (existing.startAt?.getTime() ?? null) !== (startAt?.getTime() ?? null) ||
        existing.focusText !== focusText ||
        existing.plannedMinutes !== fields.plannedMinutes ||
        existing.position !== position ||
        existing.status !== status;
      // Nothing actually changed — very often this pass is just Notion
      // echoing back exactly what an outbound push a moment ago wrote.
      // Skipping the write is what keeps that from bumping updatedAt (or
      // rewriting the reminder) forever in a no-op loop.
      if (!changed) return true;

      const [row] = await tx
        .update(schema.workSessions)
        .set({
          taskId: task.id,
          date: fields.date,
          startAt,
          focusText,
          plannedMinutes: fields.plannedMinutes,
          position,
          status,
          actualMinutes: status === "cancelled" ? null : existing.actualMinutes,
          notionSyncedAt: lastEdited,
          updatedAt: new Date(),
        })
        .where(eq(schema.workSessions.id, existing.id))
        .returning();
      if (!row) return false;

      if (status === "cancelled") {
        if (row.reminderId) await cancelSessionReminder(tx, row.reminderId);
      } else {
        const session: WorkSession = {
          id: row.id,
          userId: row.userId,
          taskId: row.taskId,
          date: row.date,
          startAt: row.startAt,
          focusText: row.focusText,
          position: row.position,
          plannedMinutes: row.plannedMinutes,
          actualMinutes: row.actualMinutes,
          status: row.status,
          reminderId: row.reminderId,
          notionPageId: row.notionPageId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        const reminderId = await syncSessionReminder(tx, session, task.title, timezone);
        if (reminderId !== existing.reminderId) {
          await tx.update(schema.workSessions).set({ reminderId }).where(eq(schema.workSessions.id, row.id));
        }
      }
      return true;
    }

    await tx.insert(schema.workSessions).values({
      userId,
      taskId: task.id,
      date: fields.date,
      startAt: fields.startAt,
      focusText,
      plannedMinutes: fields.plannedMinutes,
      position: fields.position ?? (await nextPosition(tx, userId, fields.date)),
      status,
      notionPageId: notionPage.id,
      notionSyncedAt: lastEdited,
    });
    return true;
  });
}

/**
 * Pulls whatever changed in the user's Notion Sessions database since their
 * stored cursor and mirrors it into Postgres, same pagination/cursor
 * discipline as syncNotionTasksForUser (see notion-sync.ts) with its own
 * cursor column since the two databases are polled independently.
 *
 * Run this *after* the task sync in the same tick: a session's Task relation
 * can only be resolved once the task it points at has a Postgres row.
 */
export async function syncNotionSessionsForUser(
  db: Database,
  notion: NotionClient,
  databaseId: string,
  userId: string,
): Promise<{ synced: number }> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) return { synced: 0 };

  const cursor = user.notionSessionsSyncCursor;
  let synced = 0;
  let newestSeen: Date | null = null;
  let startCursor: string | undefined;
  let done = false;

  while (!done) {
    const page = await notion.queryDatabase(databaseId, { startCursor });
    if ("error" in page) {
      console.error(`Notion session sync query failed for user ${userId}:`, page.error);
      break;
    }

    for (const notionPage of page.pages) {
      const lastEdited = new Date(notionPage.last_edited_time);
      // Strictly older, not "not newer" — see syncNotionTasksForUser for why.
      if (cursor && lastEdited.getTime() < cursor.getTime()) {
        done = true;
        break;
      }
      if (!newestSeen || lastEdited.getTime() > newestSeen.getTime()) newestSeen = lastEdited;

      if (await applyNotionSessionPage(db, notionPage, userId, lastEdited, user.timezone)) synced += 1;
    }

    if (done || !page.nextCursor) break;
    startCursor = page.nextCursor;
  }

  if (newestSeen) {
    await db
      .update(schema.users)
      .set({ notionSessionsSyncCursor: newestSeen })
      .where(eq(schema.users.id, userId));
  }

  return { synced };
}
