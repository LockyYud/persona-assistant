import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type {
  CompleteTaskInput,
  CreateSubtasksInput,
  CreateTaskInput,
  ListTasksInput,
  NowTasks,
  Pace,
  Task,
  TaskProgress,
  TaskService,
  TaskWithProgress,
  UpdateTaskInput,
} from "@persona/core";
import type { NotionClient } from "@persona/integrations";
import { cancelAutoReminders, deriveTaskReminders } from "./reminder-derivation.js";
import { pushTaskToNotion } from "./notion-sync.js";
import { toDomainTask } from "./task-mapper.js";
import { dateKeyInTimezone, localMonth, type LocalMonth } from "./local-time.js";
import { computePace } from "./pace.js";

// Unscheduled tasks aren't time-bounded, so a very old backlog could grow
// without limit — cap the returned list; unscheduledCount stays the true total.
const UNSCHEDULED_LIST_CAP = 20;
// Future-dated tasks used to be summarised by a single `nextUp`; the list is
// returned in full (capped the same way) so a client grouping by status can
// show an in-progress task that happens to be due next week instead of
// dropping it.
const FUTURE_LIST_CAP = 20;

export class DrizzleTaskService implements TaskService {
  constructor(
    private readonly db: Database,
    // When both are set, task writes are best-effort mirrored to Notion
    // (see notion-sync.ts) — a single shared database, since this app is
    // single-tenant. Inbound Notion edits are pulled back by the scheduler
    // tick, not here.
    private readonly notion?: NotionClient,
    private readonly notionDatabaseId?: string,
  ) {}

  private async syncToNotion(task: Task): Promise<Task> {
    if (!this.notion || !this.notionDatabaseId) return task;
    return pushTaskToNotion(this.db, this.notion, this.notionDatabaseId, task);
  }

  private async resolveTimezone(userId: string): Promise<string> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    return user?.timezone ?? "Asia/Bangkok";
  }

  /**
   * Minutes credited to each task this calendar month, keyed by task id.
   *
   * Only "done" sessions count. A session still sitting at "planned" is an
   * intention, and pace has to describe what actually happened or it cannot
   * detect the exact failure it exists to catch — days that were planned and
   * then not done. "skipped" is excluded as a deliberate pass. Where a
   * completed session carries no actualMinutes, the minutes it committed to
   * are credited, which is what makes ticking one off enough.
   */
  private async loadMonthlySpend(
    userId: string,
    taskIds: string[],
    month: LocalMonth,
  ): Promise<Map<string, number>> {
    const spend = new Map<string, number>();
    if (taskIds.length === 0) return spend;

    const rows = await this.db
      .select({
        taskId: schema.workSessions.taskId,
        spent: sql<number>`coalesce(sum(coalesce(${schema.workSessions.actualMinutes}, ${schema.workSessions.plannedMinutes})), 0)::int`,
      })
      .from(schema.workSessions)
      .where(
        and(
          eq(schema.workSessions.userId, userId),
          inArray(schema.workSessions.taskId, taskIds),
          eq(schema.workSessions.status, "done"),
          gte(schema.workSessions.date, month.firstDate),
          lte(schema.workSessions.date, month.lastDate),
        ),
      )
      .groupBy(schema.workSessions.taskId);

    for (const row of rows) spend.set(row.taskId, row.spent);
    return spend;
  }

  /**
   * Pace for the routine tasks among `parents`, keyed by task id. A task with
   * no monthlyTargetMinutes is absent from the map rather than present with a
   * zeroed pace — "not a routine" must not look like "a routine with nothing
   * done", the same distinction loadProgress draws for steps.
   */
  private async loadPace(
    userId: string,
    parents: Task[],
    timezone: string,
  ): Promise<Map<string, Pace>> {
    const routines = parents.filter((task) => task.monthlyTargetMinutes !== null);
    const pace = new Map<string, Pace>();
    if (routines.length === 0) return pace;

    const month = localMonth(new Date(), timezone);
    const spend = await this.loadMonthlySpend(
      userId,
      routines.map((task) => task.id),
      month,
    );

    for (const task of routines) {
      pace.set(
        task.id,
        computePace({
          targetMinutes: task.monthlyTargetMinutes as number,
          spentMinutes: spend.get(task.id) ?? 0,
          dayOfMonth: month.dayOfMonth,
          daysInMonth: month.daysInMonth,
        }),
      );
    }

    return pace;
  }

  /**
   * Step counts for the given parents, keyed by parent id. Parents with no
   * steps are simply absent from the map rather than present with a zero —
   * "no checklist" and "nothing done yet" must not look alike.
   *
   * Cancelled steps are excluded from both numerator and denominator: a step
   * you decided not to do shouldn't make the task look permanently unfinished.
   */
  private async loadProgress(parentIds: string[]): Promise<Map<string, TaskProgress>> {
    const progress = new Map<string, TaskProgress>();
    if (parentIds.length === 0) return progress;

    const rows = await this.db
      .select({
        parentTaskId: schema.tasks.parentTaskId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${schema.tasks.status} = 'done')::int`,
      })
      .from(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.parentTaskId, parentIds),
          ne(schema.tasks.status, "cancelled"),
        ),
      )
      .groupBy(schema.tasks.parentTaskId);

    for (const row of rows) {
      if (row.parentTaskId && row.total > 0) {
        progress.set(row.parentTaskId, { done: row.done, total: row.total });
      }
    }

    return progress;
  }

  /**
   * Attaches step counts and the next actionable step to top-level tasks.
   * `openSubtasks` must already be scoped to this user and exclude
   * done/cancelled steps; the earliest-created one wins, matching the order
   * the steps were written in.
   */
  private async withProgress(
    userId: string,
    parents: Task[],
    openSubtasks: Task[],
    timezone: string,
  ): Promise<TaskWithProgress[]> {
    const progress = await this.loadProgress(parents.map((task) => task.id));
    const pace = await this.loadPace(userId, parents, timezone);

    const nextStepByParent = new Map<string, Task>();
    for (const subtask of openSubtasks) {
      if (!subtask.parentTaskId) continue;
      const current = nextStepByParent.get(subtask.parentTaskId);
      if (!current || subtask.createdAt.getTime() < current.createdAt.getTime()) {
        nextStepByParent.set(subtask.parentTaskId, subtask);
      }
    }

    return parents.map((task) => ({
      ...task,
      progress: progress.get(task.id) ?? null,
      nextStep: nextStepByParent.get(task.id) ?? null,
      pace: pace.get(task.id) ?? null,
    }));
  }

  async createTask(userId: string, input: CreateTaskInput): Promise<Task> {
    const task = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.tasks)
        .values({
          userId,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority,
          type: input.type,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          monthlyTargetMinutes: input.monthlyTargetMinutes ?? null,
          parentTaskId: input.parentTaskId ?? null,
        })
        .returning();

      if (!row) throw new Error("Failed to create task");
      const task = toDomainTask(row);
      await deriveTaskReminders(tx, task);
      return task;
    });
    return this.syncToNotion(task);
  }

  async updateTask(userId: string, input: UpdateTaskInput): Promise<Task> {
    const task = await this.db.transaction(async (tx) => {
      const updates: Partial<typeof schema.tasks.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description;
      if (input.status !== undefined) updates.status = input.status;
      if (input.priority !== undefined) updates.priority = input.priority;
      if (input.type !== undefined) updates.type = input.type;
      if (input.dueAt !== undefined) updates.dueAt = input.dueAt ? new Date(input.dueAt) : null;
      if (input.monthlyTargetMinutes !== undefined) {
        updates.monthlyTargetMinutes = input.monthlyTargetMinutes;
      }
      if (input.parentTaskId !== undefined) updates.parentTaskId = input.parentTaskId;

      const [row] = await tx
        .update(schema.tasks)
        .set(updates)
        .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.userId, userId)))
        .returning();

      if (!row) throw new Error("Task not found");
      const task = toDomainTask(row);
      await deriveTaskReminders(tx, task);
      return task;
    });
    return this.syncToNotion(task);
  }

  async completeTask(userId: string, input: CompleteTaskInput): Promise<Task> {
    const task = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.userId, userId)))
        .returning();

      if (!row) throw new Error("Task not found");
      await cancelAutoReminders(tx, row.id);
      return toDomainTask(row);
    });
    return this.syncToNotion(task);
  }

  /**
   * Only top-level tasks — a step is reported through its parent's progress,
   * not as a list entry of its own. Use listSubtasks to see inside one.
   */
  async listTasks(userId: string, input: ListTasksInput): Promise<TaskWithProgress[]> {
    const conditions = input.status
      ? and(
          eq(schema.tasks.userId, userId),
          isNull(schema.tasks.parentTaskId),
          eq(schema.tasks.status, input.status),
        )
      : and(eq(schema.tasks.userId, userId), isNull(schema.tasks.parentTaskId));

    const parents = (await this.db.select().from(schema.tasks).where(conditions)).map(toDomainTask);

    // Next-step lookup needs the open steps of these parents, which the
    // parent-only query above deliberately excludes.
    const openSubtasks =
      parents.length === 0
        ? []
        : (
            await this.db
              .select()
              .from(schema.tasks)
              .where(
                and(
                  inArray(
                    schema.tasks.parentTaskId,
                    parents.map((task) => task.id),
                  ),
                  ne(schema.tasks.status, "done"),
                  ne(schema.tasks.status, "cancelled"),
                ),
              )
              .orderBy(asc(schema.tasks.createdAt))
          ).map(toDomainTask);

    return this.withProgress(userId, parents, openSubtasks, await this.resolveTimezone(userId));
  }

  async listNowTasks(userId: string): Promise<NowTasks> {
    const timezone = await this.resolveTimezone(userId);

    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, userId), ne(schema.tasks.status, "done"), ne(schema.tasks.status, "cancelled")));

    const openTasks = rows.map(toDomainTask);
    // Steps are bucketed through their parent, never on their own, so a task
    // broken into 6 steps adds one line to the view rather than seven.
    const openSubtasks = openTasks.filter((task) => task.parentTaskId !== null);
    const tasks = await this.withProgress(
      userId,
      openTasks.filter((task) => task.parentTaskId === null),
      openSubtasks,
      timezone,
    );

    const now = new Date();
    const todayKey = dateKeyInTimezone(now, timezone);

    const overdue: TaskWithProgress[] = [];
    const today: TaskWithProgress[] = [];
    const future: TaskWithProgress[] = [];
    const ongoing: TaskWithProgress[] = [];
    const unscheduled: TaskWithProgress[] = [];

    for (const task of tasks) {
      // A routine being actively pursued is bucketed by its pace, never by a
      // date. It is held out of the dueAt buckets entirely rather than also
      // appearing in one, so it stays a single line; where it does have a
      // deadline, that deadline still rides on the row itself and still
      // drives its reminders, neither of which this bucketing touches.
      //
      // A routine sitting at "open" is a paused one and lands nowhere: no
      // pace to answer for, and — unlike every other date-less task — no
      // place in `unscheduled`, since it is not waiting to be scheduled.
      if (task.monthlyTargetMinutes !== null) {
        if (task.status === "in_progress") ongoing.push(task);
        continue;
      }
      if (!task.dueAt) {
        unscheduled.push(task);
        continue;
      }
      if (task.dueAt.getTime() < now.getTime()) {
        overdue.push(task);
      } else if (dateKeyInTimezone(task.dueAt, timezone) === todayKey) {
        today.push(task);
      } else {
        future.push(task);
      }
    }

    overdue.sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
    today.sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
    future.sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
    unscheduled.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // Furthest behind first — the one that most needs today's time.
    ongoing.sort((a, b) => (a.pace?.deltaMinutes ?? 0) - (b.pace?.deltaMinutes ?? 0));

    const nextUp = overdue.length === 0 && today.length === 0 ? (future[0] ?? null) : null;

    return {
      overdue,
      today,
      nextUp,
      future: future.slice(0, FUTURE_LIST_CAP),
      ongoing,
      unscheduledCount: unscheduled.length,
      unscheduled: unscheduled.slice(0, UNSCHEDULED_LIST_CAP),
    };
  }

  async getTask(userId: string, taskId: string): Promise<Task | null> {
    const [row] = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)));

    return row ? toDomainTask(row) : null;
  }

  async listSubtasks(userId: string, parentTaskId: string): Promise<Task[]> {
    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.parentTaskId, parentTaskId)))
      .orderBy(asc(schema.tasks.createdAt));

    return rows.map(toDomainTask);
  }

  /**
   * Creates every step under one parent, inheriting the parent's type and
   * priority so a breakdown doesn't silently reclassify the work. Steps get
   * no due date of their own — the parent's deadline still drives reminders,
   * and giving each step the parent's date would multiply every reminder by
   * the number of steps.
   */
  async createSubtasks(userId: string, input: CreateSubtasksInput): Promise<Task[]> {
    const parent = await this.getTask(userId, input.parentTaskId);
    if (!parent) throw new Error("Parent task not found");
    if (parent.parentTaskId) throw new Error("Cannot nest steps under another step");

    const created = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.tasks)
        .values(
          input.titles.map((title) => ({
            userId,
            title,
            priority: parent.priority,
            type: parent.type,
            parentTaskId: parent.id,
          })),
        )
        .returning();

      return rows.map(toDomainTask);
    });

    // Mirrored one at a time: each needs its own Notion page, and the push is
    // best-effort per task (see pushTaskToNotion) so one failure can't lose
    // the rest.
    const mirrored: Task[] = [];
    for (const subtask of created) {
      mirrored.push(await this.syncToNotion(subtask));
    }
    return mirrored;
  }
}
