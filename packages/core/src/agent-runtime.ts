export interface ChatMessageInput {
  userId: string;
  message: string;
  conversationId?: string;
}

export interface ChatResult {
  conversationId: string;
  reply: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  agentRunId: string;
}

export interface TriggeredWorkflowInput {
  userId: string;
  trigger: string;
  payload: Record<string, unknown>;
}

/**
 * Runtime-agnostic surface the worker depends on. DeepSeekHarnessAdapter is the
 * only implementation in the MVP; task/reminder persistence never calls this
 * directly so the runtime can be swapped without touching scheduling.
 */
export interface AgentRuntime {
  chat(input: ChatMessageInput): Promise<ChatResult>;
  runTriggeredWorkflow(input: TriggeredWorkflowInput): Promise<void>;
}

export const AGENT_TOOL_NAMES = [
  "createTask",
  "listTasks",
  "updateTask",
  "completeTask",
  "createReminder",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
