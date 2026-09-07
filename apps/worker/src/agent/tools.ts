import {
  completeSessionInputSchema,
  completeTaskInputSchema,
  createReminderInputSchema,
  createSubtasksInputSchema,
  createTaskInputSchema,
  listSessionsInputSchema,
  listTasksInputSchema,
  planSessionInputSchema,
  proposeTaskBreakdownInputSchema,
  skipSessionInputSchema,
  updateTaskInputSchema,
  type ReminderService,
  type SessionService,
  type TaskService,
} from "@persona/core";
import { schema, type Database } from "@persona/db";
import { eq } from "drizzle-orm";
import type { NotionClient, TavilyClient } from "@persona/integrations";
import type { TaskBreakdownService } from "../services/task-breakdown.js";
import { dateKeyInTimezone } from "../services/local-time.js";
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
        description:
          "List the user's tasks (the same list as their Notion Tasks database), optionally filtered by status. Returns top-level tasks with their step counts. Use this for the full list; use listNowTasks for what needs attention now.",
        parameters: zodToJsonSchema(listTasksInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "listNowTasks",
        description:
          "The user's tasks that need attention, already bucketed into overdue / due today / next up, plus any with no due date. This is the right tool for open questions like 'check my tasks', 'what should I do', 'what's on my plate' — including when they mention Notion, since it is the same list.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
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
        name: "listSubtasks",
        description:
          "List the steps of one task, oldest first. Use when the user asks what's left on a task or how far along it is in detail.",
        parameters: {
          type: "object",
          properties: { parentTaskId: { type: "string", description: "The parent task's id." } },
          required: ["parentTaskId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "proposeTaskBreakdown",
        description:
          "Suggest the steps a task should be split into. Creates nothing — always show the proposed steps to the user, then call createSubtasks to actually create them. Pass anything the user said about how to split it as `context`.",
        parameters: zodToJsonSchema(proposeTaskBreakdownInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "listToday",
        description:
          "What the user committed to today, plus every routine still asking for time this month with its pace. THE tool for 'what am I doing today', 'what should I work on', 'am I on track', 'how's my English going'. Returns each routine's target, what's been done this month, whether it is behind, and how many minutes to suggest for today.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "planSession",
        description:
          "Record that the user is spending a stretch of a day on one task — 'today I'll study English for an hour' becomes planSession(taskId, plannedMinutes: 60). Only for tasks pursued at a rate (they have a monthly target); ordinary one-off tasks do not need sessions. There is one session per task per day, so calling this again for the same day revises it rather than adding a second. Pass startAt only if the user named a time, which is also what earns the session a reminder.",
        parameters: zodToJsonSchema(planSessionInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "completeSession",
        description:
          "Mark today's session on a task as done. Omit actualMinutes when the user just says they did it — the minutes they committed to are credited. Pass actualMinutes when they say how long it really took ('I only managed 20 minutes').",
        parameters: zodToJsonSchema(completeSessionInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "skipSession",
        description:
          "Record that the user is deliberately passing on a planned session ('skip the gym today, I'm ill'). A deliberate skip does not count against their monthly pace, whereas silently letting the day go by does — so use this rather than leaving it alone.",
        parameters: zodToJsonSchema(skipSessionInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "listSessions",
        description:
          "The user's session history, optionally for one task and/or a date range (YYYY-MM-DD). Use when they ask how consistent they have been, or what they did on a particular day.",
        parameters: zodToJsonSchema(listSessionsInputSchema) as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "createSubtasks",
        description:
          "Create the given steps under a task. Requires the user's confirmation, so pass the exact step titles they agreed to — usually the ones proposeTaskBreakdown returned.",
        parameters: zodToJsonSchema(createSubtasksInputSchema) as Record<string, unknown>,
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
            "Search the user's Notion workspace for notes and documents. NOT for tasks — the user's tasks are already available through listNowTasks/listTasks, which read the same Notion database; use those instead even if the user says 'Notion'.",
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
            "Get the text content of one Notion page by its ID, after notion_search located it. Reads a single page — never call it repeatedly to sweep a list of pages, and never to read tasks.",
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
  sessionService: SessionService;
  notion?: NotionClient;
  tavily?: TavilyClient;
  breakdown?: TaskBreakdownService;
}

async function resolveTimezone(ctx: ToolContext): Promise<string> {
  const [user] = await ctx.db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId));
  return user?.timezone ?? "Asia/Bangkok";
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
    case "listNowTasks": {
      return ctx.taskService.listNowTasks(ctx.userId);
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
    case "listSubtasks": {
      const { parentTaskId } = rawArgs as { parentTaskId: string };
      return ctx.taskService.listSubtasks(ctx.userId, parentTaskId);
    }
    case "proposeTaskBreakdown": {
      if (!ctx.breakdown) return { error: "Task breakdown is not configured" };
      const input = proposeTaskBreakdownInputSchema.parse(rawArgs);

      const task = await ctx.taskService.getTask(ctx.userId, input.taskId);
      if (!task) return { error: "Task not found" };

      const existing = await ctx.taskService.listSubtasks(ctx.userId, task.id);
      if (existing.length > 0) {
        return {
          error: "This task already has steps. Show them with listSubtasks instead of re-splitting.",
          steps: existing.map((step) => step.title),
        };
      }

      // The page body is usually where a task's real detail lives, so feed it
      // in when there is one — a title alone rarely has enough to split well.
      let context = input.context;
      if (ctx.notion && task.notionPageId) {
        const page = await ctx.notion.getPage(task.notionPageId);
        if (!("error" in page) && page.content.trim()) {
          context = [context, `Notion page content:\n${page.content}`].filter(Boolean).join("\n\n");
        }
      }

      const { steps } = await ctx.breakdown.propose(task, context);
      if (steps.length === 0) {
        return { error: "Could not produce a usable breakdown for this task." };
      }

      return { taskId: task.id, taskTitle: task.title, steps };
    }
    case "listToday": {
      // Both halves, because they answer different questions: what has been
      // committed to, and what the month still needs. A caller comparing them
      // is how "1h planned of the 1.2h today wants" gets said.
      const timezone = await resolveTimezone(ctx);
      const date = dateKeyInTimezone(new Date(), timezone);
      const [sessions, now] = await Promise.all([
        ctx.sessionService.listSessionsForDate(ctx.userId, date),
        ctx.taskService.listNowTasks(ctx.userId),
      ]);
      return { date, timezone, sessions, ongoing: now.ongoing };
    }
    case "planSession": {
      const input = planSessionInputSchema.parse(rawArgs);
      return ctx.sessionService.planSession(ctx.userId, input);
    }
    case "completeSession": {
      const input = completeSessionInputSchema.parse(rawArgs);
      return ctx.sessionService.completeSession(ctx.userId, input);
    }
    case "skipSession": {
      const input = skipSessionInputSchema.parse(rawArgs);
      return ctx.sessionService.skipSession(ctx.userId, input);
    }
    case "listSessions": {
      const input = listSessionsInputSchema.parse(rawArgs);
      return ctx.sessionService.listSessions(ctx.userId, input);
    }
    case "createSubtasks": {
      const input = createSubtasksInputSchema.parse(rawArgs);
      return ctx.taskService.createSubtasks(ctx.userId, input);
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
