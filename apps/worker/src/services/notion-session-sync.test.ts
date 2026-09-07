import { describe, expect, it } from "vitest";
import type { WorkSession } from "@persona/core";
import { sessionToNotionProperties } from "./notion-session-sync.js";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    userId: "u1",
    taskId: "t1",
    date: "2026-09-07",
    startAt: null,
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

  it("puts the duration in the title, since that is all a calendar block shows", () => {
    const props = sessionToNotionProperties(
      session({ plannedMinutes: 90 }),
      "Học tiếng Anh",
      "task-page-1",
    );

    expect(props.Title).toEqual({ title: [{ text: { content: "Học tiếng Anh · 1h30m" } }] });
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
      "Planned",
      "Status",
      "Task",
      "Title",
    ]);
  });
});
