import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotionClient } from "@persona/integrations";
import type {
  CompleteSessionInput,
  CancelSessionInput,
  ListSessionsInput,
  PlanTodayInput,
  PlanSessionInput,
  SessionService,
  SetTodayPlanInput,
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
    return this.requirePlannableTask(toDomainTask(row));
  }

  private requirePlannableTask(task: Task): Task {
    if (task.parentTaskId) throw new Error("Steps cannot be planned as Today items");
    if (task.status === "done" || task.status === "cancelled") {
      throw new Error("Task is no longer active for planning");
    }
    return task;
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

  private async writeSession(
    tx: Tx,
    task: Task,
    date: string,
    input: Pick<PlanSessionInput, "sessionId" | "plannedMinutes" | "focusText" | "startAt">,
    timezone: string,
    position?: number,
  ): Promise<WorkSession> {
    if (input.startAt && dateKeyInTimezone(new Date(input.startAt), timezone) !== date) {
      throw new Error("startAt must be on the session's local calendar day");
    }
    const [existing] = input.sessionId
      ? await tx
          .select()
          .from(schema.workSessions)
          .where(and(eq(schema.workSessions.id, input.sessionId), eq(schema.workSessions.userId, task.userId)))
          .for("update")
      : [];

    if (input.sessionId && (!existing || existing.date !== date || existing.taskId !== task.id)) {
      throw new Error("Today item is no longer available for this plan");
    }
    if (existing && existing.status !== "planned") {
      throw new Error("Only planned Today items can be revised");
    }

    if (!existing) {
      const [last] = await tx
        .select({ position: schema.workSessions.position })
        .from(schema.workSessions)
        .where(and(eq(schema.workSessions.userId, task.userId), eq(schema.workSessions.date, date)))
        .orderBy(sql`${schema.workSessions.position} desc`)
        .limit(1);
      const [row] = await tx
        .insert(schema.workSessions)
        .values({
          userId: task.userId,
          taskId: task.id,
          date,
          plannedMinutes: input.plannedMinutes,
          focusText: input.focusText ?? null,
          startAt: input.startAt ? new Date(input.startAt) : null,
          position: position ?? (last?.position ?? 0) + 1,
        })
        .returning();
      if (!row) throw new Error("Failed to plan session");
      return this.reconcileReminder(tx, toDomainSession(row), task.title, timezone);
    }

    const updates: Partial<typeof schema.workSessions.$inferInsert> = {
      plannedMinutes: input.plannedMinutes,
      position: position ?? existing.position,
      updatedAt: new Date(),
    };
    if (input.focusText !== undefined) updates.focusText = input.focusText;
    if (input.startAt !== undefined) {
      updates.startAt = input.startAt === null ? null : new Date(input.startAt);
    }

    const [row] = await tx
      .update(schema.workSessions)
      .set(updates)
      .where(eq(schema.workSessions.id, existing.id))
      .returning();
    if (!row) throw new Error("Failed to revise session");
    return this.reconcileReminder(tx, toDomainSession(row), task.title, timezone);
  }

  /**
   * Replays the old planToday contract for approvals created before the
   * replace-style setTodayPlan tool. It upserts only the tasks in its payload;
   * it never cancels unrelated planned sessions.
   */
  private async writeLegacySession(
    tx: Tx,
    task: Task,
    date: string,
    input: Pick<PlanTodayInput["items"][number], "plannedMinutes" | "focusText" | "startAt">,
    timezone: string,
  ): Promise<WorkSession> {
    if (input.startAt && dateKeyInTimezone(new Date(input.startAt), timezone) !== date) {
      throw new Error("startAt must be on the session's local calendar day");
    }
    const [existing] = await tx
      .select()
      .from(schema.workSessions)
      .where(
        and(
          eq(schema.workSessions.taskId, task.id),
          eq(schema.workSessions.userId, task.userId),
          eq(schema.workSessions.date, date),
        ),
      )
      .for("update");

    if (!existing) {
      const [last] = await tx
        .select({ position: schema.workSessions.position })
        .from(schema.workSessions)
        .where(and(eq(schema.workSessions.userId, task.userId), eq(schema.workSessions.date, date)))
        .orderBy(sql`${schema.workSessions.position} desc`)
        .limit(1);
      const [row] = await tx
        .insert(schema.workSessions)
        .values({
          userId: task.userId,
          taskId: task.id,
          date,
          plannedMinutes: input.plannedMinutes,
          focusText: input.focusText ?? null,
          startAt: input.startAt ? new Date(input.startAt) : null,
          position: (last?.position ?? 0) + 1,
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
    if (input.focusText !== undefined) updates.focusText = input.focusText;
    if (input.startAt !== undefined) updates.startAt = new Date(input.startAt);

    const [row] = await tx
      .update(schema.workSessions)
      .set(updates)
      .where(eq(schema.workSessions.id, existing.id))
      .returning();
    if (!row) throw new Error("Failed to revise session");
    return this.reconcileReminder(tx, toDomainSession(row), task.title, timezone);
  }

  /** Appends a commitment or revises the explicitly identified planned item. */
  async planSession(userId: string, input: PlanSessionInput): Promise<WorkSession> {
    const task = await this.requireTask(userId, input.taskId);
    const timezone = await this.resolveTimezone(userId);
    const date = input.date ?? dateKeyInTimezone(new Date(), timezone);

    const session = await this.db.transaction((tx) => this.writeSession(tx, task, date, input, timezone));

    return this.syncToNotion(session);
  }

  async setTodayPlan(userId: string, input: SetTodayPlanInput): Promise<WorkSession[]> {
    if (input.items.reduce((total, item) => total + item.plannedMinutes, 0) > 24 * 60) {
      throw new Error("Today plan exceeds one day");
    }
    const timezone = await this.resolveTimezone(userId);
    const date = dateKeyInTimezone(new Date(), timezone);
    const sessions = await this.db.transaction(async (tx) => {
      const existingPlanned = await tx
        .select()
        .from(schema.workSessions)
        .where(
          and(
            eq(schema.workSessions.userId, userId),
            eq(schema.workSessions.date, date),
            eq(schema.workSessions.status, "planned"),
          ),
        )
        .for("update");
      const existingIds = new Set(existingPlanned.map((session) => session.id));
      const retainedIds = new Set(input.items.flatMap((item) => (item.sessionId ? [item.sessionId] : [])));
      for (const id of retainedIds) {
        if (!existingIds.has(id)) throw new Error("Today item is no longer available for this plan");
      }
      const tasks: Task[] = [];
      for (const item of input.items) {
        const [row] = await tx
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, item.taskId), eq(schema.tasks.userId, userId)))
          .for("update");
        if (!row) throw new Error("Task not found");
        tasks.push(this.requirePlannableTask(toDomainTask(row)));
      }
      const written: WorkSession[] = [];
      for (const [index, item] of input.items.entries()) {
        const task = tasks[index];
        if (!task) throw new Error("Task not found");
        written.push(await this.writeSession(tx, task, date, item, timezone, index + 1));
      }
      const cancelled: WorkSession[] = [];
      for (const existing of existingPlanned) {
        if (retainedIds.has(existing.id)) continue;
        const [row] = await tx
          .update(schema.workSessions)
          .set({ status: "cancelled", actualMinutes: null, updatedAt: new Date() })
          .where(eq(schema.workSessions.id, existing.id))
          .returning();
        if (row) cancelled.push(await this.dropReminder(tx, toDomainSession(row)));
      }
      return [...written, ...cancelled];
    });
    return Promise.all(sessions.map((session) => this.syncToNotion(session)));
  }

  async planToday(userId: string, input: PlanTodayInput): Promise<WorkSession[]> {
    const taskIds = new Set(input.items.map((item) => item.taskId));
    if (taskIds.size !== input.items.length) throw new Error("A task may appear only once in Today");
    if (input.items.reduce((total, item) => total + item.plannedMinutes, 0) > 24 * 60) {
      throw new Error("Today plan exceeds one day");
    }
    const timezone = await this.resolveTimezone(userId);
    const date = dateKeyInTimezone(new Date(), timezone);
    const sessions = await this.db.transaction(async (tx) => {
      const tasks: Task[] = [];
      for (const item of input.items) {
        const [row] = await tx
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, item.taskId), eq(schema.tasks.userId, userId)))
          .for("update");
        if (!row) throw new Error("Task not found");
        tasks.push(this.requirePlannableTask(toDomainTask(row)));
      }
      const written: WorkSession[] = [];
      for (const [index, item] of input.items.entries()) {
        const task = tasks[index];
        if (!task) throw new Error("Task not found");
        written.push(await this.writeLegacySession(tx, task, date, item, timezone));
      }
      return written;
    });
    return Promise.all(sessions.map((session) => this.syncToNotion(session)));
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
          and(
            eq(schema.workSessions.id, input.sessionId),
            eq(schema.workSessions.userId, userId),
            eq(schema.workSessions.status, "planned"),
          ),
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
          and(
            eq(schema.workSessions.id, input.sessionId),
            eq(schema.workSessions.userId, userId),
            eq(schema.workSessions.status, "planned"),
          ),
        )
        .returning();
      if (!row) throw new Error("Session not found");
      return this.dropReminder(tx, toDomainSession(row));
    });

    return this.syncToNotion(session);
  }

  async cancelSession(userId: string, input: CancelSessionInput): Promise<WorkSession> {
    const session = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.workSessions)
        .set({ status: "cancelled", actualMinutes: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workSessions.id, input.sessionId),
            eq(schema.workSessions.userId, userId),
            eq(schema.workSessions.status, "planned"),
          ),
        )
        .returning();
      if (!row) throw new Error("Planned session not found");
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
      .orderBy(asc(schema.workSessions.position), asc(schema.workSessions.createdAt));

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
      .orderBy(asc(schema.workSessions.date), asc(schema.workSessions.position));

    return rows.map(toDomainSession);
  }
}
