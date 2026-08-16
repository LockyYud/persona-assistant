export type ToolPolicy = "auto" | "confirm";

/**
 * Every registered tool must have an explicit entry. Read/create/update on
 * tasks and reminders is low-risk and auto-approved; anything destructive or
 * externally visible (future: send email, delete a Notion page, deploy)
 * should be added here as "confirm" so it routes through the approval flow
 * instead of executing immediately. Unlisted tool names default to
 * "confirm" — a new tool is unsafe until someone deliberately allowlists it.
 */
const TOOL_POLICIES: Record<string, ToolPolicy> = {
  createTask: "auto",
  listTasks: "auto",
  updateTask: "auto",
  completeTask: "auto",
  createReminder: "auto",
  confirmAction: "auto",
  rejectAction: "auto",
};

export function getToolPolicy(toolName: string): ToolPolicy {
  return TOOL_POLICIES[toolName] ?? "confirm";
}
