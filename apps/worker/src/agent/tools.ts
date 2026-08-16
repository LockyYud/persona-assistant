import { z } from "zod";
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
import { resolveApproval } from "./approvals.js";

const confirmActionInputSchema = z.object({ approvalId: z.string().uuid() });
const rejectActionInputSchema = z.object({ approvalId: z.string().uuid() });

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
    {
      type: "function",
      function: {
        name: "confirmAction",
        description:
          "Confirm and execute a previously requested action that is pending the user's approval.",
        parameters: zodToJsonSchema(confirmActionInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "rejectAction",
        description: "Decline a previously requested action that is pending the user's approval.",
        parameters: zodToJsonSchema(rejectActionInputSchema) as Record<string, unknown>,
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
    case "confirmAction": {
      const { approvalId } = confirmActionInputSchema.parse(rawArgs);
      const approval = await resolveApproval(ctx.db, approvalId, ctx.userId, "approved");
      if (!approval) return { error: "No matching pending approval found." };
      return executeTool(approval.action, approval.payload, ctx);
    }
    case "rejectAction": {
      const { approvalId } = rejectActionInputSchema.parse(rawArgs);
      const approval = await resolveApproval(ctx.db, approvalId, ctx.userId, "rejected");
      if (!approval) return { error: "No matching pending approval found." };
      return { status: "rejected", approvalId };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
