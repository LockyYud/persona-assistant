import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient } from "@persona/integrations";
import type {
  CompleteSessionInput,
  ListSessionsInput,
  PlanSessionInput,
  SessionService,
  SkipSessionInput,
  Task,
  WorkSession,
  WorkSessionWithTask,
} from "@persona/core";
import { dateKeyInTimezone } from "./local-time.js";
import { pushSessionToNotion } from "./notion-session-sync.js";
import { cancelSessionReminder, syncSessionReminder } from "./session-reminders.js";
import { toDomainTask } from "./task-mapper.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function toDomainSession(row: typeof schema.workSessions.$inferSelect): WorkSession {
  return {
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    date: row.date,
    startAt: row.startAt,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    status: row.status,
    reminderId: row.reminderId,
    notionPageId: row.notionPageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Day planning: which goals get time today, and how much.
 *
 * Nothing here generates sessions. A session exists because the user picked
 * that task for that day, from the desktop widget or in chat — so there is no
 * recurrence rule to store, no horizon to materialise ahead of time, and
 * nothing to reconcile when the plan changes.
 */
export class DrizzleSessionService implements SessionService {
  constructor(
    private readonly db: Database,
    // When both are set, every session write is best-effort mirrored to a
    // Notion database of its own (see notion-session-sync.ts) so the day's
    // plan shows up on the user's calendar. One direction only — nothing is
    // ever read back from it.
    private readonly notion?: NotionClient,
    private readonly notionDatabaseId?: string,
  ) {}

  private async syncToNotion(session: WorkSession): Promise<WorkSession> {
    if (!this.notion || !this.notionDatabaseId) return session;
    return pushSessionToNotion(this.db, this.notion, this.notionDatabaseId, session);
  }

  private async resolveTimezone(userId: string): Promise<string> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    return user?.timezone ?? "Asia/Bangkok";
  }

  private async requireTask(userId: string, taskId: string): Promise<Task> {
    const [row] = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)));
    if (!row) throw new Error("Task not found");
    return toDomainTask(row);
  }

  /**
   * Brings the session's reminder in line with it and writes the resulting id
   * back, in the same transaction as the session write — the same discipline
   * task writes follow with deriveTaskReminders, so a session and its reminder
   * can never disagree.
   */
  private async reconcileReminder(
    tx: Tx,
    session: WorkSession,
    taskTitle: string,
    timezone: string,
  ): Promise<WorkSession> {
    const reminderId = await syncSessionReminder(tx, session, taskTitle, timezone);
    if (reminderId === session.reminderId) return session;

    const [row] = await tx
      .update(schema.workSessions)
      .set({ reminderId })
      .where(eq(schema.workSessions.id, session.id))
      .returning();
    return row ? toDomainSession(row) : { ...session, reminderId };
  }

  /**
   * Cancels the reminder of a session that has been closed out. Finishing at
   * 18:00 something planned for 19:00 should not still ring.
   */
  private async dropReminder(tx: Tx, session: WorkSession): Promise<WorkSession> {
    if (!session.reminderId) return session;
    await cancelSessionReminder(tx, session.reminderId);

    const [row] = await tx
      .update(schema.workSessions)
      .set({ reminderId: null })
      .where(eq(schema.workSessions.id, session.id))
      .returning();
    return row ? toDomainSession(row) : { ...session, reminderId: null };
  }

  /**
   * Commits a stretch of a day to one task.
   *
   * Idempotent per (task, day): because there can only be one session per task
   * per day, planning the same pair again has to mean "actually, make it 90
   * minutes" rather than failing. Two details of that revision are deliberate.
   * A day previously passed on comes back to life, since re-planning it is
   * plainly a change of mind; but a session already finished stays finished —
   * revising a commitment is not the same as un-doing work that happened. And
   * an omitted startAt leaves any existing one alone rather than clearing it,
   * so adjusting the length of a session doesn't silently strip its time.
   */
  async planSession(userId: string, input: PlanSessionInput): Promise<WorkSession> {
    const task = await this.requireTask(userId, input.taskId);
    const timezone = await this.resolveTimezone(userId);
    const date = input.date ?? dateKeyInTimezone(new Date(), timezone);

    const session = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.workSessions)
        .where(and(eq(schema.workSessions.taskId, task.id), eq(schema.workSessions.date, date)))
        .for("update");

      if (!existing) {
        const [row] = await tx
          .insert(schema.workSessions)
          .values({
            userId,
            taskId: task.id,
            date,
            plannedMinutes: input.plannedMinutes,
            startAt: input.startAt ? new Date(input.startAt) : null,
          })
          .returning();
        if (!row) throw new Error("Failed to plan session");
        return this.reconcileReminder(tx, toDomainSession(row), task.title, timezone);
      }

      const updates: Partial<typeof schema.workSessions.$inferInsert> = {
        plannedMinutes: input.plannedMinutes,
        status: existing.status === "skipped" ? "planned" : existing.status,
        updatedAt: new Date(),
      };
      if (input.startAt !== undefined) updates.startAt = new Date(input.startAt);

      const [row] = await tx
        .update(schema.workSessions)
        .set(updates)
        .where(eq(schema.workSessions.id, existing.id))
        .returning();
      if (!row) throw new Error("Failed to revise session");
      return this.reconcileReminder(tx, toDomainSession(row), task.title, timezone);
    });

    return this.syncToNotion(session);
  }

  /**
   * Closes a session out as done. Omitting actualMinutes credits the minutes
   * committed to, so ticking a session off never requires typing a number;
   * passing one records what actually happened instead.
   */
  async completeSession(userId: string, input: CompleteSessionInput): Promise<WorkSession> {
    const session = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.workSessions)
        .set({
          status: "done",
          actualMinutes:
            input.actualMinutes ??
            sql`coalesce(${schema.workSessions.actualMinutes}, ${schema.workSessions.plannedMinutes})`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.workSessions.id, input.sessionId), eq(schema.workSessions.userId, userId)),
        )
        .returning();
      if (!row) throw new Error("Session not found");
      return this.dropReminder(tx, toDomainSession(row));
    });

    return this.syncToNotion(session);
  }

  /**
   * A deliberate pass, excluded from the pace numerator — as opposed to simply
   * letting the day go by, which leaves the session "planned" and counts as a
   * miss. Any minutes previously recorded are cleared, because a skipped
   * session is one that did not happen.
   */
  async skipSession(userId: string, input: SkipSessionInput): Promise<WorkSession> {
    const session = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.workSessions)
        .set({ status: "skipped", actualMinutes: null, updatedAt: new Date() })
        .where(
          and(eq(schema.workSessions.id, input.sessionId), eq(schema.workSessions.userId, userId)),
        )
        .returning();
      if (!row) throw new Error("Session not found");
      return this.dropReminder(tx, toDomainSession(row));
    });

    return this.syncToNotion(session);
  }

  async listSessionsForDate(userId: string, date: string): Promise<WorkSessionWithTask[]> {
    const rows = await this.db
      .select({ session: schema.workSessions, task: schema.tasks })
      .from(schema.workSessions)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workSessions.taskId))
      .where(and(eq(schema.workSessions.userId, userId), eq(schema.workSessions.date, date)))
      // Timed sessions first, in clock order; the rest keep their planning
      // order, so "what am I doing today" reads top to bottom.
      .orderBy(asc(schema.workSessions.startAt), asc(schema.workSessions.createdAt));

    return rows.map(({ session, task }) => ({
      ...toDomainSession(session),
      task: toDomainTask(task),
    }));
  }

  async listSessions(userId: string, input: ListSessionsInput): Promise<WorkSession[]> {
    const filters = [eq(schema.workSessions.userId, userId)];
    if (input.taskId) filters.push(eq(schema.workSessions.taskId, input.taskId));
    if (input.from) filters.push(gte(schema.workSessions.date, input.from));
    if (input.to) filters.push(lte(schema.workSessions.date, input.to));

    const rows = await this.db
      .select()
      .from(schema.workSessions)
      .where(and(...filters))
      .orderBy(asc(schema.workSessions.date));

    return rows.map(toDomainSession);
  }
}
