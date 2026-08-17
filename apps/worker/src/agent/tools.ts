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
import type { NotionClient, TavilyClient } from "@persona/integrations";
import type { ChatCompletionTool } from "openai/resources/index.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ToolDefinitionOptions {
  notionEnabled: boolean;
  webSearchEnabled: boolean;
}

export function buildToolDefinitions(
  options: ToolDefinitionOptions = { notionEnabled: false, webSearchEnabled: false },
): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [
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

  if (options.notionEnabled) {
    tools.push(
      {
        type: "function",
        function: {
          name: "notion_search",
          description:
            "Search the user's Notion workspace for pages and databases matching a query. Use when the user asks about notes, docs, or info that might be stored in Notion.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search text." },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "notion_get_page",
          description:
            "Get the text content of a Notion page by its ID. Use after notion_search to read a specific page's content.",
          parameters: {
            type: "object",
            properties: {
              pageId: { type: "string", description: "The Notion page ID (from notion_search results)." },
            },
            required: ["pageId"],
            additionalProperties: false,
          },
        },
      },
    );
  }

  if (options.webSearchEnabled) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the public web. Use when the user asks about current events, recent information, facts, or anything requiring an internet lookup beyond your training data.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query in natural language." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    });
  }

  return tools;
}

export interface ToolContext {
  userId: string;
  db: Database;
  taskService: TaskService;
  reminderService: ReminderService;
  notion?: NotionClient;
  tavily?: TavilyClient;
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
    case "notion_search": {
      if (!ctx.notion) return { error: "Notion is not configured" };
      const { query } = rawArgs as { query: string };
      return ctx.notion.search(query);
    }
    case "notion_get_page": {
      if (!ctx.notion) return { error: "Notion is not configured" };
      const { pageId } = rawArgs as { pageId: string };
      return ctx.notion.getPage(pageId);
    }
    case "web_search": {
      if (!ctx.tavily) return { error: "Web search is not configured" };
      const { query } = rawArgs as { query: string };
      return ctx.tavily.search(query);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
