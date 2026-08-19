import { describe, expect, it } from "vitest";
import type { NotionPage } from "@persona/integrations";
import type { Task } from "@persona/core";
import { notionPageToTaskFields, taskToNotionProperties } from "./notion-sync.js";

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
    });
  });
});
