import { and, eq, ne } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type {
  CompleteTaskInput,
  CreateTaskInput,
  ListTasksInput,
  NowTasks,
  Task,
  TaskService,
  UpdateTaskInput,
} from "@persona/core";
import type { NotionClient } from "@persona/integrations";
import { cancelAutoReminders, deriveTaskReminders } from "./reminder-derivation.js";
import { pushTaskToNotion } from "./notion-sync.js";

// Unscheduled tasks aren't time-bounded, so a very old backlog could grow
// without limit — cap the returned list; unscheduledCount stays the true total.
const UNSCHEDULED_LIST_CAP = 20;

function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

function toDomainTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    type: row.type,
    dueAt: row.dueAt,
    notionPageId: row.notionPageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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

  async listTasks(userId: string, input: ListTasksInput): Promise<Task[]> {
    const conditions = input.status
      ? and(eq(schema.tasks.userId, userId), eq(schema.tasks.status, input.status))
      : eq(schema.tasks.userId, userId);

    const rows = await this.db.select().from(schema.tasks).where(conditions);
    return rows.map(toDomainTask);
  }

  async listNowTasks(userId: string): Promise<NowTasks> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    const timezone = user?.timezone ?? "Asia/Bangkok";

    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, userId), ne(schema.tasks.status, "done"), ne(schema.tasks.status, "cancelled")));

    const tasks = rows.map(toDomainTask);
    const now = new Date();
    const todayKey = dateKeyInTimezone(now, timezone);

    const overdue: Task[] = [];
    const today: Task[] = [];
    const future: Task[] = [];
    const unscheduled: Task[] = [];

    for (const task of tasks) {
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

    const nextUp = overdue.length === 0 && today.length === 0 ? (future[0] ?? null) : null;

    return {
      overdue,
      today,
      nextUp,
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
}
