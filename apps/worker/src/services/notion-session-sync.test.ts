import { describe, expect, it } from "vitest";
import type { NotionPage } from "@persona/integrations";
import type { WorkSession } from "@persona/core";
import {
  parseNotionSessionPage,
  resolveInboundFocusText,
  sessionToNotionProperties,
} from "./notion-session-sync.js";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    userId: "u1",
    taskId: "t1",
    date: "2026-09-07",
    startAt: null,
    focusText: null,
    position: 1,
    plannedMinutes: 60,
    actualMinutes: null,
    status: "planned",
    reminderId: null,
    notionPageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("sessionToNotionProperties", () => {
  it("gives a timed session a start and an end, so it renders as a calendar block", () => {
    const props = sessionToNotionProperties(
      session({ startAt: new Date("2026-09-07T12:00:00.000Z"), plannedMinutes: 90 }),
      "Học tiếng Anh",
      "task-page-1",
    );

    expect(props.Date).toEqual({
      date: { start: "2026-09-07T12:00:00.000Z", end: "2026-09-07T13:30:00.000Z" },
    });
  });

  it("gives an untimed session a bare date, which renders as all-day", () => {
    const props = sessionToNotionProperties(session(), "Học tiếng Anh", "task-page-1");

    expect(props.Date).toEqual({ date: { start: "2026-09-07" } });
  });

  it("titles an unfocused session with the task's own name", () => {
    const props = sessionToNotionProperties(session(), "Học tiếng Anh", "task-page-1");

    expect(props.Title).toEqual({ title: [{ text: { content: "Học tiếng Anh" } }] });
    expect(props.Focus).toEqual({ rich_text: [] });
  });

  it("titles a focused session with the focus text, and mirrors it into Focus", () => {
    const props = sessionToNotionProperties(
      session({ focusText: "Run baseline", plannedMinutes: 90 }),
      "RAG Lab",
      "task-page-1",
    );

    expect(props.Title).toEqual({ title: [{ text: { content: "Run baseline" } }] });
    expect(props.Focus).toEqual({ rich_text: [{ text: { content: "Run baseline" } }] });
  });

  it("carries position through as Order", () => {
    const props = sessionToNotionProperties(session({ position: 3 }), "Học tiếng Anh", "task-page-1");

    expect(props.Order).toEqual({ number: 3 });
  });

  it("leaves the relation empty when the task has no Notion page yet", () => {
    // Worth creating the session page anyway; a later write links it up once
    // the task has been mirrored.
    const props = sessionToNotionProperties(session(), "Học tiếng Anh", null);

    expect(props.Task).toEqual({ relation: [] });
  });

  it("carries actual minutes and status through once the session is closed out", () => {
    const props = sessionToNotionProperties(
      session({ status: "done", actualMinutes: 45 }),
      "Học tiếng Anh",
      "task-page-1",
    );

    expect(props.Planned).toEqual({ number: 60 });
    expect(props.Actual).toEqual({ number: 45 });
    expect(props.Status).toEqual({ select: { name: "done" } });
  });

  it("clears Actual rather than omitting it, so a skipped session doesn't keep stale minutes", () => {
    const props = sessionToNotionProperties(
      session({ status: "skipped", actualMinutes: null }),
      "Gym",
      "task-page-1",
    );

    expect(props.Actual).toEqual({ number: null });
    expect(props.Status).toEqual({ select: { name: "skipped" } });
  });

  it("writes nothing about pace", () => {
    // Pace changes daily; writing it would bump last_edited_time on every
    // sync, which is the loop the tasks database needs its Progress guard for.
    const props = sessionToNotionProperties(session(), "Học tiếng Anh", "task-page-1");

    expect(Object.keys(props).sort()).toEqual([
      "Actual",
      "Date",
      "Focus",
      "Order",
      "Planned",
      "Status",
      "Task",
      "Title",
    ]);
  });
});

function page(properties: NotionPage["properties"], overrides: Partial<NotionPage> = {}): NotionPage {
  return {
    id: "session-page-1",
    url: "https://notion.so/session-page-1",
    last_edited_time: "2026-09-07T00:00:00.000Z",
    properties,
    ...overrides,
  };
}

describe("parseNotionSessionPage", () => {
  it("reads title, focus, task relation, planned minutes, order and status", () => {
    const fields = parseNotionSessionPage(
      page({
        Title: { type: "title", title: [{ plain_text: "Run baseline" }] },
        Focus: { rich_text: [{ plain_text: "Run baseline" }] },
        Task: { relation: [{ id: "task-page-1" }] },
        Date: { date: { start: "2026-09-07" } },
        Planned: { number: 60 },
        Order: { number: 2 },
        Status: { select: { name: "planned" } },
      }),
    );

    expect(fields).toEqual({
      title: "Run baseline",
      focusText: "Run baseline",
      taskNotionPageId: "task-page-1",
      date: "2026-09-07",
      startAt: null,
      plannedMinutes: 60,
      position: 2,
      status: "planned",
    });
  });

  it("derives a bare date's startAt as null, an all-day item", () => {
    const fields = parseNotionSessionPage(page({ Date: { date: { start: "2026-09-07" } } }));

    expect(fields.date).toBe("2026-09-07");
    expect(fields.startAt).toBeNull();
  });

  it("derives startAt from a Date property that carries a time", () => {
    const fields = parseNotionSessionPage(
      page({ Date: { date: { start: "2026-09-07T09:00:00.000+07:00" } } }),
    );

    expect(fields.date).toBe("2026-09-07");
    expect(fields.startAt).toEqual(new Date("2026-09-07T09:00:00.000+07:00"));
  });

  it("falls back to safe defaults for a blank/unrecognized row", () => {
    const fields = parseNotionSessionPage(page({ Title: { type: "title", title: [] } }));

    expect(fields).toEqual({
      title: "",
      focusText: null,
      taskNotionPageId: null,
      date: null,
      startAt: null,
      plannedMinutes: null,
      position: null,
      status: "planned",
    });
  });

  it("falls back to planned for an unrecognized status", () => {
    const fields = parseNotionSessionPage(page({ Status: { select: { name: "not_a_real_status" } } }));

    expect(fields.status).toBe("planned");
  });
});

describe("resolveInboundFocusText", () => {
  it("prefers Focus when present", () => {
    expect(resolveInboundFocusText("Run baseline", "Học tiếng Anh", "Học tiếng Anh")).toBe(
      "Run baseline",
    );
  });

  it("falls back to Title when Focus is blank and Title differs from the task", () => {
    expect(resolveInboundFocusText(null, "Ôn từ vựng", "Học tiếng Anh")).toBe("Ôn từ vựng");
  });

  it("treats Title equal to the task's own name as no focus at all", () => {
    expect(resolveInboundFocusText(null, "Học tiếng Anh", "Học tiếng Anh")).toBeNull();
  });

  it("treats a blank Title the same as no focus", () => {
    expect(resolveInboundFocusText(null, "  ", "Học tiếng Anh")).toBeNull();
  });
});
