import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import { schema, type Database } from "@persona/db";
import type { NotionClient } from "@persona/integrations";
import type {
  AgentRuntime,
  ChatMessageInput,
  ChatResult,
  PendingApproval,
  ReminderService,
  TaskService,
  TriggeredWorkflowInput,
} from "@persona/core";
import { buildToolDefinitions, executeTool } from "./tools.js";
import { getToolPolicy } from "./permissions.js";
import { createApprovalRequest } from "./approvals.js";
import { extractMemoryCandidates } from "../memory/extractor.js";
import {
  appendMessage,
  getPendingApproval,
  listMemoryKeys,
  loadRecentMessages,
  loadTopMemories,
  resolveConversationId,
  touchMemoriesLastUsed,
  upsertMemory,
} from "../memory/repository.js";

const BASE_SYSTEM_PROMPT = `You are Duy's personal assistant. You can create and manage tasks
and reminders on his behalf using the provided tools. Always confirm what you did in plain,
concise language. Times you pass to tools must be ISO-8601 UTC datetimes.

Some actions require the user's explicit confirmation before they run. When a tool result says
an action is pending confirmation, tell the user what it would do and that a Confirm/Cancel
button has been shown to them. You cannot confirm or cancel it yourself — only the user's own
button press does that.`;

const MAX_TOOL_ITERATIONS = 5;

export interface LlmProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

/**
 * Thin adapter over any OpenAI-compatible chat completions API (OpenAI,
 * DeepSeek, Gemini's OpenAI-compat endpoint, OpenRouter, local vLLM, ...).
 * apiKey/baseURL/model are runtime config, not hardcoded, so switching
 * providers is an env var change. The rest of the app only depends on the
 * AgentRuntime contract and tool set, never on this class directly.
 *
 * A provider with a genuinely different wire format (e.g. native Anthropic
 * Messages API) needs its own AgentRuntime implementation instead of reusing
 * this one.
 */
export class OpenAICompatibleAgentAdapter implements AgentRuntime {
  private readonly client: OpenAI;
  private readonly tools: ReturnType<typeof buildToolDefinitions>;
  private readonly model: string;
  private readonly runtimeLabel: string;

  constructor(
    private readonly db: Database,
    private readonly taskService: TaskService,
    private readonly reminderService: ReminderService,
    provider: LlmProviderConfig,
    private readonly notion?: NotionClient,
  ) {
    this.client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
    this.model = provider.model;
    this.runtimeLabel = provider.baseURL ?? "openai";
    this.tools = buildToolDefinitions({ notionEnabled: !!notion });
  }

  async chat(input: ChatMessageInput): Promise<ChatResult> {
    const conversationId = await resolveConversationId(this.db, input.userId, input.conversationId);

    const history = await loadRecentMessages(this.db, conversationId);
    const memories = await loadTopMemories(this.db, input.userId);
    const pendingApproval = await getPendingApproval(this.db, input.userId);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt(memories, pendingApproval, !!this.notion) },
      ...history,
      { role: "user", content: input.message },
    ];
    // Everything from here on is new this turn (assistant/tool messages the
    // loop below appends) — used to know what to persist afterwards.
    const turnStartIndex = messages.length;

    const toolCalls: ChatResult["toolCalls"] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let reply = "";
    let error: string | null = null;

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools: this.tools,
        });

        promptTokens += completion.usage?.prompt_tokens ?? 0;
        completionTokens += completion.usage?.completion_tokens ?? 0;

        const choice = completion.choices[0];
        const message = choice?.message;
        if (!message) break;

        messages.push(message);

        if (!message.tool_calls || message.tool_calls.length === 0) {
          reply = message.content ?? "";
          break;
        }

        for (const call of message.tool_calls) {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const output = await this.runTool(call.function.name, args, input.userId);

          toolCalls.push({ name: call.function.name, input: args, output });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output),
          });
        }
      }
    } catch (runError) {
      error = runError instanceof Error ? runError.message : String(runError);
    }

    const finalReply = error ? "Sorry, something went wrong processing that." : reply;

    const [agentRun] = await this.db
      .insert(schema.agentRuns)
      .values({
        userId: input.userId,
        runtime: this.runtimeLabel,
        model: this.model,
        promptTokens,
        completionTokens,
        toolCalls: toolCalls.map((call) => ({ name: call.name, input: call.input })),
        error,
      })
      .returning({ id: schema.agentRuns.id });

    if (!error) {
      await this.persistTurn(
        conversationId,
        input.userId,
        input.message,
        messages.slice(turnStartIndex),
        memories,
      );
    }

    const newPendingApproval = extractPendingApproval(toolCalls);

    return {
      conversationId,
      reply: finalReply,
      toolCalls,
      agentRunId: agentRun?.id ?? "",
      pendingApproval: newPendingApproval,
    };
  }

  private async runTool(name: string, args: unknown, userId: string): Promise<unknown> {
    const policy = getToolPolicy(name);

    if (policy === "confirm") {
      const approval = await createApprovalRequest(this.db, {
        userId,
        agentRunId: null,
        action: name,
        payload: args,
      });
      return {
        status: "pending_confirmation",
        approvalId: approval.id,
        message: `This action (${name}) requires your confirmation before it runs.`,
      };
    }

    try {
      return await executeTool(name, args, {
        userId,
        db: this.db,
        taskService: this.taskService,
        reminderService: this.reminderService,
        notion: this.notion,
      });
    } catch (toolError) {
      return { error: toolError instanceof Error ? toolError.message : String(toolError) };
    }
  }

  /**
   * Persists the user's message plus every assistant/tool message the loop
   * produced this turn, extracts any durable facts worth remembering, and
   * marks the memories that informed this turn as recently used.
   */
  private async persistTurn(
    conversationId: string,
    userId: string,
    userMessage: string,
    newMessages: ChatCompletionMessageParam[],
    memoriesUsed: (typeof schema.memories.$inferSelect)[],
  ): Promise<void> {
    await appendMessage(this.db, {
      conversationId,
      userId,
      role: "user",
      content: userMessage,
    });

    for (const message of newMessages) {
      if (message.role === "assistant") {
        await appendMessage(this.db, {
          conversationId,
          userId,
          role: "assistant",
          content: typeof message.content === "string" ? message.content : null,
          toolCalls: message.tool_calls ?? undefined,
        });
      } else if (message.role === "tool") {
        await appendMessage(this.db, {
          conversationId,
          userId,
          role: "tool",
          content:
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          toolCallId: message.tool_call_id,
        });
      }
    }

    if (memoriesUsed.length > 0) {
      await touchMemoriesLastUsed(
        this.db,
        memoriesUsed.map((m) => m.id),
      );
    }

    const assistantReplyText = [...newMessages]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string");
    const replyText =
      assistantReplyText?.role === "assistant" && typeof assistantReplyText.content === "string"
        ? assistantReplyText.content
        : "";

    const existingKeys = await listMemoryKeys(this.db, userId);
    const candidates = await extractMemoryCandidates(
      this.client,
      this.model,
      userMessage,
      replyText,
      existingKeys,
    );
    for (const candidate of candidates) {
      await upsertMemory(this.db, userId, candidate, "conversation");
    }
  }

  async runTriggeredWorkflow(_input: TriggeredWorkflowInput): Promise<void> {
    // Not used by the MVP: reminders are delivered via the deterministic
    // outbox/Telegram path, not through the LLM.
    return;
  }
}

function extractPendingApproval(toolCalls: ChatResult["toolCalls"]): PendingApproval | null {
  for (const call of toolCalls) {
    const output = call.output as { status?: string; approvalId?: string } | null;
    if (output && output.status === "pending_confirmation" && output.approvalId) {
      return { approvalId: output.approvalId, action: call.name, payload: call.input };
    }
  }
  return null;
}

function buildSystemPrompt(
  memories: (typeof schema.memories.$inferSelect)[],
  pendingApproval: (typeof schema.approvalRequests.$inferSelect) | null,
  notionEnabled: boolean,
): string {
  const sections = [BASE_SYSTEM_PROMPT];

  if (notionEnabled) {
    sections.push(
      "You have access to the user's Notion workspace via notion_search and notion_get_page. " +
        "Use notion_search to find relevant pages when the user asks about notes, docs, or stored " +
        "information, then notion_get_page to read a specific page's content.",
    );
  }

  if (memories.length > 0) {
    const facts = memories.map((m) => `- (${m.type}) ${m.content}`).join("\n");
    sections.push(`Known context about the user:\n${facts}`);
  }

  if (pendingApproval) {
    sections.push(
      `There is a pending action awaiting the user's confirmation via a button you already ` +
        `showed them: action="${pendingApproval.action}" payload=${JSON.stringify(pendingApproval.payload)}. ` +
        `You cannot confirm or cancel it yourself — if the user asks about it, remind them to use the button.`,
    );
  }

  return sections.join("\n\n");
}
