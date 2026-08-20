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
  listSubtasks: "auto",
  updateTask: "auto",
  completeTask: "auto",
  createReminder: "auto",
  notion_search: "auto",
  notion_get_page: "auto",
  web_search: "auto",
  // Proposing steps writes nothing, so it runs freely. Actually creating them
  // does not: a breakdown can add up to 20 rows to the user's real Notion
  // database at once, and the model's idea of the right steps is exactly the
  // kind of judgement the user should get to veto first. Left unlisted on
  // purpose so it inherits the "confirm" default — see createSubtasks in
  // schemas.ts for why the titles travel in the approval payload.
  proposeTaskBreakdown: "auto",
};

export function getToolPolicy(toolName: string): ToolPolicy {
  return TOOL_POLICIES[toolName] ?? "confirm";
}
