import type { schema } from "@persona/db";
import type { Task } from "@persona/core";

/**
 * The one place a task row becomes a domain Task.
 *
 * It lives in its own module rather than on either service because both
 * task-service and notion-sync need it, and task-service already imports
 * notion-sync — putting it on either side would close that into a cycle.
 */
export function toDomainTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    type: row.type,
    dueAt: row.dueAt,
    monthlyTargetMinutes: row.monthlyTargetMinutes,
    parentTaskId: row.parentTaskId,
    notionPageId: row.notionPageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
