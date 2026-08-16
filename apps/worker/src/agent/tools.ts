import {
  completeTaskInputSchema,
  createReminderInputSchema,
  createTaskInputSchema,
  listTasksInputSchema,
  updateTaskInputSchema,
  type ReminderService,
  type TaskService,
} from "@persona/core";
import type { Database } from "@persona/db";
import type { ChatCompletionTool } from "openai/resources/index.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export function buildToolDefinitions(): ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "createTask",
        description: "Create a new task for the user.",
        parameters: zodToJsonSchema(createTaskInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "listTasks",
        description: "List the user's tasks, optionally filtered by status.",
        parameters: zodToJsonSchema(listTasksInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "updateTask",
        description: "Update fields on an existing task.",
        parameters: zodToJsonSchema(updateTaskInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "completeTask",
        description: "Mark a task as done.",
        parameters: zodToJsonSchema(completeTaskInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "createReminder",
        description:
          "Create a reminder tied to a task. nextRunAt must be an ISO-8601 UTC datetime.",
        parameters: zodToJsonSchema(createReminderInputSchema) as Record<string, unknown>,
      },
    },
  ];
}

export interface ToolContext {
  userId: string;
  db: Database;
  taskService: TaskService;
  reminderService: ReminderService;
}

/**
 * Deliberately no "confirmAction"/"rejectAction" tool exists here. Approving
 * a pending action is a decision only a real user-originated signal (a
 * Telegram button callback, a web click) may make — never a model tool call.
 * See apps/worker/src/agent/approvals.ts and the /telegram/webhook
 * callback_query handling / POST /approvals/:id routes in app.ts.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "createTask": {
      const input = createTaskInputSchema.parse(rawArgs);
      return ctx.taskService.createTask(ctx.userId, input);
    }
    case "listTasks": {
      const input = listTasksInputSchema.parse(rawArgs);
      return ctx.taskService.listTasks(ctx.userId, input);
    }
    case "updateTask": {
      const input = updateTaskInputSchema.parse(rawArgs);
      return ctx.taskService.updateTask(ctx.userId, input);
    }
    case "completeTask": {
      const input = completeTaskInputSchema.parse(rawArgs);
      return ctx.taskService.completeTask(ctx.userId, input);
    }
    case "createReminder": {
      const input = createReminderInputSchema.parse(rawArgs);
      return ctx.reminderService.createReminder(ctx.userId, input);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
