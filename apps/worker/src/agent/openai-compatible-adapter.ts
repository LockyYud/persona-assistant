import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import { schema, type Database } from "@persona/db";
import type {
  AgentRuntime,
  ChatMessageInput,
  ChatResult,
  ReminderService,
  TaskService,
  TriggeredWorkflowInput,
} from "@persona/core";
import { buildToolDefinitions, executeTool } from "./tools.js";

const SYSTEM_PROMPT = `You are Duy's personal assistant. You can create and manage tasks and
reminders on his behalf using the provided tools. Always confirm what you did in plain,
concise language. Times you pass to tools must be ISO-8601 UTC datetimes.`;

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
  private readonly tools = buildToolDefinitions();
  private readonly model: string;
  private readonly runtimeLabel: string;

  constructor(
    private readonly db: Database,
    private readonly taskService: TaskService,
    private readonly reminderService: ReminderService,
    provider: LlmProviderConfig,
  ) {
    this.client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
    this.model = provider.model;
    this.runtimeLabel = provider.baseURL ?? "openai";
  }

  async chat(input: ChatMessageInput): Promise<ChatResult> {
    const conversationId = input.conversationId ?? randomUUID();
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.message },
    ];

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
          let output: unknown;
          try {
            output = await executeTool(call.function.name, args, {
              userId: input.userId,
              taskService: this.taskService,
              reminderService: this.reminderService,
            });
          } catch (toolError) {
            output = { error: toolError instanceof Error ? toolError.message : String(toolError) };
          }

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

    return {
      conversationId,
      reply: error ? "Sorry, something went wrong processing that." : reply,
      toolCalls,
      agentRunId: agentRun?.id ?? "",
    };
  }

  async runTriggeredWorkflow(_input: TriggeredWorkflowInput): Promise<void> {
    // Not used by the MVP: reminders are delivered via the deterministic
    // outbox/Telegram path, not through the LLM.
    return;
  }
}
