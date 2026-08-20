import { describe, expect, it } from "vitest";
import type { NotionPage } from "@persona/integrations";
import type { Task } from "@persona/core";
import { isBlankNotionPage, notionPageToTaskFields, taskToNotionProperties } from "./notion-sync.js";

function makePage(properties: NotionPage["properties"]): NotionPage {
  return { id: "page-1", url: "https://notion.so/page-1", last_edited_time: "2026-08-01T00:00:00.000Z", properties };
}

/**
 * Notion's API is written with `{ text: { content } }` rich_text items but
 * always read back with an added `plain_text` (and other computed fields) —
 * this mimics that echo so a write payload can be fed straight back into
 * notionPageToTaskFields, the way a real create-then-query round trip would.
 */
function asReadFormat(writeProperties: Record<string, unknown>): NotionPage["properties"] {
  const withPlainText = (richText: unknown) =>
    Array.isArray(richText)
      ? richText.map((item) => ({ ...item, plain_text: item.text?.content ?? "" }))
      : richText;

  return Object.fromEntries(
    Object.entries(writeProperties).map(([key, value]) => {
      const prop = value as { title?: unknown; rich_text?: unknown };
      if (prop.title) return [key, { type: "title", title: withPlainText(prop.title) }];
      if (prop.rich_text) return [key, { rich_text: withPlainText(prop.rich_text) }];
      return [key, value];
    }),
  );
}

describe("notionPageToTaskFields", () => {
  it("reads title, status, priority, type, due date and description from Notion properties", () => {
    const fields = notionPageToTaskFields(
      makePage({
        Name: { type: "title", title: [{ plain_text: "Buy milk" }] },
        Status: { select: { name: "in_progress" } },
        Priority: { select: { name: "high" } },
        Type: { select: { name: "chore" } },
        Due: { date: { start: "2026-08-20T10:00:00.000Z" } },
        Description: { rich_text: [{ plain_text: "2% please" }] },
      }),
    );

    expect(fields).toEqual({
      title: "Buy milk",
      description: "2% please",
      status: "in_progress",
      priority: "high",
      type: "chore",
      dueAt: new Date("2026-08-20T10:00:00.000Z"),
      parentNotionPageId: null,
    });
  });

  it("falls back to safe defaults for missing/unknown fields", () => {
    const fields = notionPageToTaskFields(
      makePage({
        Name: { type: "title", title: [] },
        Status: { select: { name: "not_a_real_status" } },
        Priority: { select: null },
        Type: { select: { name: "not_a_real_type" } },
      }),
    );

    expect(fields).toEqual({
      title: "(untitled)",
      description: null,
      status: "open",
      priority: "medium",
      type: "personal",
      dueAt: null,
      parentNotionPageId: null,
    });
  });
});

describe("taskToNotionProperties", () => {
  it("round-trips through notionPageToTaskFields", () => {
    const task: Task = {
      id: "task-1",
      userId: "user-1",
      title: "Ship the release",
      description: "Tag v1.2.0 and deploy",
      status: "open",
      priority: "urgent",
      type: "work",
      dueAt: new Date("2026-08-25T09:00:00.000Z"),
      parentTaskId: null,
      notionPageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const fields = notionPageToTaskFields(makePage(asReadFormat(taskToNotionProperties(task))));

    expect(fields).toEqual({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      type: task.type,
      dueAt: task.dueAt,
      parentNotionPageId: null,
    });
  });
});

describe("parent relation mapping", () => {
  it("reads the parent's page id out of the Parent relation", () => {
    const fields = notionPageToTaskFields(
      makePage({
        Name: { type: "title", title: [{ plain_text: "A step" }] },
        // Notion allows several related pages, but a task has one parent —
        // extras are ignored rather than silently changing which one wins.
        Parent: { relation: [{ id: "parent-page-1" }, { id: "parent-page-2" }] },
      }),
    );

    expect(fields.parentNotionPageId).toBe("parent-page-1");
  });

  it("writes the Parent relation only when a parent page id is supplied", () => {
    const task: Task = {
      id: "task-1",
      userId: "user-1",
      title: "A step",
      description: null,
      status: "open",
      priority: "medium",
      type: "work",
      dueAt: null,
      parentTaskId: "parent-task-uuid",
      notionPageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // The parent's *page* id has to be passed in — a task only knows its
    // parent's uuid, which means nothing to Notion.
    expect(taskToNotionProperties(task, "parent-page-1").Parent).toEqual({
      relation: [{ id: "parent-page-1" }],
    });
    // An empty relation clears the link rather than leaving a stale one.
    expect(taskToNotionProperties(task, null).Parent).toEqual({ relation: [] });
  });
});

describe("isBlankNotionPage", () => {
  it("flags rows with no title so Notion's trailing empty row never becomes a task", () => {
    expect(isBlankNotionPage(makePage({ Title: { type: "title", title: [] } }))).toBe(true);
    // Whitespace-only counts as blank too — it produces an equally useless task.
    expect(
      isBlankNotionPage(makePage({ Title: { type: "title", title: [{ plain_text: "   " }] } })),
    ).toBe(true);
  });

  it("does not flag a row that has a real title", () => {
    expect(
      isBlankNotionPage(makePage({ Title: { type: "title", title: [{ plain_text: "Real task" }] } })),
    ).toBe(false);
  });
});
