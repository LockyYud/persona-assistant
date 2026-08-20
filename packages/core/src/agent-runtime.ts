export interface ChatMessageInput {
  userId: string;
  message: string;
  conversationId?: string;
  /** Threads are kept per channel, so "continue my last thread" means the right one. */
  channel?: "web" | "telegram";
  /** Set by an explicit "New chat"; omitting conversationId only means "continue". */
  startNewConversation?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  action: string;
  payload: unknown;
}

export interface ChatResult {
  conversationId: string;
  reply: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  agentRunId: string;
  /**
   * Set when a tool call this turn required confirmation. The channel is
   * responsible for surfacing a real user-originated confirm/reject action
   * (a Telegram inline button, a web button) — the model never resolves this
   * itself.
   */
  pendingApproval: PendingApproval | null;
}

export interface TriggeredWorkflowInput {
  userId: string;
  trigger: string;
  payload: Record<string, unknown>;
}

/**
 * Runtime-agnostic surface the worker depends on. OpenAICompatibleAgentAdapter
 * is the only implementation in the MVP; task/reminder persistence never
 * calls this directly so the runtime can be swapped without touching
 * scheduling.
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
