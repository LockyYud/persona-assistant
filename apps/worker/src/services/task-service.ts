import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type {
  CompleteTaskInput,
  CreateTaskInput,
  ListTasksInput,
  Task,
  TaskService,
  UpdateTaskInput,
} from "@persona/core";

function toDomainTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleTaskService implements TaskService {
  constructor(private readonly db: Database) {}

  async createTask(userId: string, input: CreateTaskInput): Promise<Task> {
    const [row] = await this.db
      .insert(schema.tasks)
      .values({
        userId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      })
      .returning();

    if (!row) throw new Error("Failed to create task");
    return toDomainTask(row);
  }

  async updateTask(userId: string, input: UpdateTaskInput): Promise<Task> {
    const updates: Partial<typeof schema.tasks.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.status !== undefined) updates.status = input.status;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.dueAt !== undefined) updates.dueAt = input.dueAt ? new Date(input.dueAt) : null;

    const [row] = await this.db
      .update(schema.tasks)
      .set(updates)
      .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.userId, userId)))
      .returning();

    if (!row) throw new Error("Task not found");
    return toDomainTask(row);
  }

  async completeTask(userId: string, input: CompleteTaskInput): Promise<Task> {
    const [row] = await this.db
      .update(schema.tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.userId, userId)))
      .returning();

    if (!row) throw new Error("Task not found");
    return toDomainTask(row);
  }

  async listTasks(userId: string, input: ListTasksInput): Promise<Task[]> {
    const conditions = input.status
      ? and(eq(schema.tasks.userId, userId), eq(schema.tasks.status, input.status))
      : eq(schema.tasks.userId, userId);

    const rows = await this.db.select().from(schema.tasks).where(conditions);
    return rows.map(toDomainTask);
  }

  async getTask(userId: string, taskId: string): Promise<Task | null> {
    const [row] = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)));

    return row ? toDomainTask(row) : null;
  }
}
