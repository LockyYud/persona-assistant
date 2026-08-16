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

  it("auto-approves the confirmation meta-tools themselves", () => {
    expect(getToolPolicy("confirmAction")).toBe("auto");
    expect(getToolPolicy("rejectAction")).toBe("auto");
  });

  it("defaults an unlisted tool name to confirm", () => {
    expect(getToolPolicy("deleteEverything")).toBe("confirm");
    expect(getToolPolicy("sendEmail")).toBe("confirm");
  });
});
