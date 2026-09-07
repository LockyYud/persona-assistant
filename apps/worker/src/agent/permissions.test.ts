import { describe, expect, it } from "vitest";
import { getToolPolicy } from "./permissions.js";

describe("getToolPolicy", () => {
  it("auto-approves the existing task/reminder tools", () => {
    for (const name of [
      "createTask",
      "listTasks",
      "updateTask",
      "completeTask",
      "createReminder",
    ]) {
      expect(getToolPolicy(name)).toBe("auto");
    }
  });

  it("auto-approves the session tools, which each touch one day of one task", () => {
    for (const name of [
      "listToday",
      "planSession",
      "completeSession",
      "skipSession",
      "listSessions",
    ]) {
      expect(getToolPolicy(name)).toBe("auto");
    }
  });

  it("keeps createSubtasks behind confirmation even though sessions are not", () => {
    // The contrast is the point: a session is one revisable row in the user's
    // own plan, while a breakdown can add twenty rows to their real Notion
    // database in one call.
    expect(getToolPolicy("createSubtasks")).toBe("confirm");
    expect(getToolPolicy("proposeTaskBreakdown")).toBe("auto");
  });

  it("defaults an unlisted tool name to confirm, including the old confirmAction/rejectAction meta-tools", () => {
    // confirmAction/rejectAction are no longer LLM-callable tools at all — approving
    // a pending action is only ever triggered by a real user-originated signal
    // (Telegram button, web click), never a model tool call. This case guards
    // against them accidentally being reintroduced into TOOL_POLICIES as "auto".
    expect(getToolPolicy("confirmAction")).toBe("confirm");
    expect(getToolPolicy("rejectAction")).toBe("confirm");
    expect(getToolPolicy("deleteEverything")).toBe("confirm");
    expect(getToolPolicy("sendEmail")).toBe("confirm");
  });
});
