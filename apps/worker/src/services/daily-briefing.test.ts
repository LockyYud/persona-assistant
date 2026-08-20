import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type OpenAI from "openai";
import { schema } from "@persona/db";
import type { NowTasks, TaskWithProgress } from "@persona/core";
import { getTestDb, resetTestDb } from "../test-support/db.js";
import { DrizzleTaskService } from "./task-service.js";
import {
  hasBriefingContent,
  isBriefingDue,
  renderBriefing,
  sendDailyBriefings,
  type BriefingUser,
} from "./daily-briefing.js";

const BANGKOK = "Asia/Bangkok"; // UTC+7, no DST

function user(overrides: Partial<BriefingUser> = {}): BriefingUser {
  return {
    timezone: BANGKOK,
    briefingEnabled: true,
    briefingHour: 7,
    briefingMinute: 0,
    lastBriefingOn: null,
    telegramChatId: "123",
    ...overrides,
  };
}

/** 07:00 Bangkok == 00:00 UTC, which makes these cases readable. */
function utc(iso: string): Date {
  return new Date(iso);
}

function task(overrides: Partial<TaskWithProgress> = {}): TaskWithProgress {
  return {
    id: "t1",
    userId: "u1",
    title: "Task",
    description: null,
    status: "open",
    priority: "medium",
    type: "work",
    dueAt: new Date("2026-08-20T05:00:00.000Z"),
    parentTaskId: null,
    notionPageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    progress: null,
    nextStep: null,
    ...overrides,
  };
}

function nowTasks(overrides: Partial<NowTasks> = {}): NowTasks {
  return {
    overdue: [],
    today: [],
    nextUp: null,
    unscheduledCount: 0,
    unscheduled: [],
    ...overrides,
  };
}

describe("isBriefingDue", () => {
  it("fires once the local target time has passed, not on UTC time", () => {
    // 23:30 UTC is 06:30 Bangkok — before the 07:00 target.
    expect(isBriefingDue(user(), utc("2026-08-19T23:30:00.000Z"))).toBe(false);
    // 00:30 UTC is 07:30 Bangkok — past it.
    expect(isBriefingDue(user(), utc("2026-08-20T00:30:00.000Z"))).toBe(true);
  });

  it("does not fire twice on the same local day", () => {
    const at0730 = utc("2026-08-20T00:30:00.000Z"); // 2026-08-20 07:30 Bangkok
    expect(isBriefingDue(user({ lastBriefingOn: "2026-08-20" }), at0730)).toBe(false);
    // Yesterday's send must not block today's.
    expect(isBriefingDue(user({ lastBriefingOn: "2026-08-19" }), at0730)).toBe(true);
  });

  it("uses the LOCAL day for that check, not the UTC day", () => {
    // 17:00 UTC on the 19th is already 00:00 on the 20th in Bangkok, so a
    // briefing recorded for the 20th must suppress it — a UTC-based
    // comparison would wrongly let it through.
    const justAfterLocalMidnight = utc("2026-08-19T17:10:00.000Z");
    expect(
      isBriefingDue(
        user({ briefingHour: 0, briefingMinute: 5, lastBriefingOn: "2026-08-20" }),
        justAfterLocalMidnight,
      ),
    ).toBe(false);
  });

  it("catches up a missed target but gives up once it is far too late", () => {
    // Target 07:00; the tick may not have run (host asleep, scheduler failure).
    const at1030 = utc("2026-08-20T03:30:00.000Z"); // 10:30 Bangkok, 3.5h late
    expect(isBriefingDue(user(), at1030)).toBe(true);

    const at1900 = utc("2026-08-20T12:00:00.000Z"); // 19:00 Bangkok
    // A "here's your morning" at dinner time is worse than none at all.
    expect(isBriefingDue(user(), at1900)).toBe(false);
  });

  it("respects the enabled flag and needs somewhere to deliver", () => {
    const at0730 = utc("2026-08-20T00:30:00.000Z");
    expect(isBriefingDue(user({ briefingEnabled: false }), at0730)).toBe(false);
    expect(isBriefingDue(user({ telegramChatId: null }), at0730)).toBe(false);
  });

  it("honours a custom time", () => {
    const at0605 = utc("2026-08-19T23:05:00.000Z"); // 06:05 Bangkok
    expect(isBriefingDue(user({ briefingHour: 6, briefingMinute: 0 }), at0605)).toBe(true);
    expect(isBriefingDue(user({ briefingHour: 6, briefingMinute: 30 }), at0605)).toBe(false);
  });

  it("works for a timezone on the other side of UTC", () => {
    // 12:30 UTC is 07:30 in New York (EDT, UTC-4).
    const ny = user({ timezone: "America/New_York" });
    expect(isBriefingDue(ny, utc("2026-08-20T12:30:00.000Z"))).toBe(true);
    expect(isBriefingDue(ny, utc("2026-08-20T09:30:00.000Z"))).toBe(false);
  });
});

describe("hasBriefingContent", () => {
  it("is worth sending only when something is overdue or due today", () => {
    expect(hasBriefingContent(nowTasks({ overdue: [task()] }))).toBe(true);
    expect(hasBriefingContent(nowTasks({ today: [task()] }))).toBe(true);
  });

  it("stays quiet for a backlog or a merely upcoming task", () => {
    // A daily "nothing due today" trains the reader to ignore the channel,
    // which costs more than it gives on the days something is actually wrong.
    expect(hasBriefingContent(nowTasks({ unscheduledCount: 12 }))).toBe(false);
    expect(hasBriefingContent(nowTasks({ nextUp: task() }))).toBe(false);
    expect(hasBriefingContent(nowTasks())).toBe(false);
  });
});

describe("renderBriefing", () => {
  it("includes counts, step progress and the next step", () => {
    const text = renderBriefing(
      nowTasks({
        overdue: [task({ title: "Ship release", progress: { done: 2, total: 5 }, nextStep: task({ title: "Viết test" }) })],
        today: [task({ title: "Gọi khách", priority: "urgent" })],
        unscheduledCount: 3,
      }),
    );

    expect(text).toContain("Quá hạn (1)");
    expect(text).toContain("Ship release");
    expect(text).toContain("2/5 bước");
    expect(text).toContain("tiếp: Viết test");
    expect(text).toContain("Hôm nay (1)");
    expect(text).toContain("urgent");
    expect(text).toContain("3 task chưa có hạn");
  });

  it("leaves out sections that have nothing in them", () => {
    const text = renderBriefing(nowTasks({ today: [task({ title: "Chỉ có hôm nay" })] }));

    expect(text).not.toContain("Quá hạn");
    expect(text).not.toContain("Sắp tới");
    expect(text).not.toContain("chưa có hạn");
  });
});

describe("sendDailyBriefings", () => {
  beforeEach(resetTestDb);

  const AT_0730_BANGKOK = utc("2026-08-20T00:30:00.000Z");

  /**
   * A client whose call always fails, to prove the plain rendering still gets
   * delivered when the nicer wording can't be produced.
   */
  const failingClient = {
    chat: { completions: { create: async () => { throw new Error("LLM down"); } } },
  } as unknown as OpenAI;

  function composingClient(text: string) {
    return {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: JSON.stringify({ text }) } }] }),
        },
      },
    } as unknown as OpenAI;
  }

  async function briefingUser(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
    const [row] = await getTestDb()
      .insert(schema.users)
      .values({
        email: `b-${randomUUID()}@example.com`,
        timezone: BANGKOK,
        telegramChatId: "555",
        ...overrides,
      })
      .returning();
    return row!;
  }

  function recordingChannel(sent: string[]) {
    return {
      send: async ({ text }: { chatId: string; text: string }) => {
        sent.push(text);
        return { providerMessageId: "1" };
      },
    };
  }

  it("sends the composed briefing and records the local day", async () => {
    const db = getTestDb();
    const row = await briefingUser();
    const service = new DrizzleTaskService(db);
    await service.createTask(row.id, {
      title: "Quá hạn rồi",
      priority: "high",
      type: "work",
      dueAt: new Date("2026-08-19T02:00:00.000Z").toISOString(),
    });

    const sent: string[] = [];
    const result = await sendDailyBriefings({
      db,
      channel: recordingChannel(sent),
      taskService: service,
      client: composingClient("Hôm nay nên xử lý Quá hạn rồi trước."),
      model: "test-model",
      now: AT_0730_BANGKOK,
    });

    expect(result.sent).toBe(1);
    expect(sent).toEqual(["Hôm nay nên xử lý Quá hạn rồi trước."]);

    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(after?.lastBriefingOn).toBe("2026-08-20");
  });

  it("falls back to the plain rendering when the model call fails", async () => {
    const db = getTestDb();
    const row = await briefingUser();
    const service = new DrizzleTaskService(db);
    await service.createTask(row.id, {
      title: "Việc gấp",
      priority: "urgent",
      type: "work",
      dueAt: new Date("2026-08-19T02:00:00.000Z").toISOString(),
    });

    const sent: string[] = [];
    const result = await sendDailyBriefings({
      db,
      channel: recordingChannel(sent),
      taskService: service,
      client: failingClient,
      model: "test-model",
      now: AT_0730_BANGKOK,
    });

    // A failed composition must not cost the user their briefing.
    expect(result.sent).toBe(1);
    expect(sent[0]).toContain("Việc gấp");
    expect(sent[0]).toContain("Quá hạn");
  });

  it("sends nothing on a quiet day but still marks the day as handled", async () => {
    const db = getTestDb();
    const row = await briefingUser();
    const service = new DrizzleTaskService(db);
    // Backlog only — no deadline today, nothing overdue.
    await service.createTask(row.id, { title: "Ngày nào đó", priority: "low", type: "personal" });

    const sent: string[] = [];
    const result = await sendDailyBriefings({
      db,
      channel: recordingChannel(sent),
      taskService: service,
      client: composingClient("should not be used"),
      model: "test-model",
      now: AT_0730_BANGKOK,
    });

    expect(sent).toEqual([]);
    expect(result.skipped).toBe(1);
    // Marked anyway, so the rest of the catch-up window doesn't re-evaluate it.
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(after?.lastBriefingOn).toBe("2026-08-20");
  });

  it("does not send twice when the tick runs again the same morning", async () => {
    const db = getTestDb();
    const row = await briefingUser();
    const service = new DrizzleTaskService(db);
    await service.createTask(row.id, {
      title: "Một lần thôi",
      priority: "high",
      type: "work",
      dueAt: new Date("2026-08-19T02:00:00.000Z").toISOString(),
    });

    const sent: string[] = [];
    const deps = {
      db,
      channel: recordingChannel(sent),
      taskService: service,
      client: composingClient("briefing"),
      model: "test-model",
      now: AT_0730_BANGKOK,
    };

    await sendDailyBriefings(deps);
    // The tick runs every couple of minutes; the second pass must be a no-op.
    await sendDailyBriefings({ ...deps, now: utc("2026-08-20T00:34:00.000Z") });

    expect(sent).toHaveLength(1);
  });

  it("leaves the day unmarked when delivery fails, so the next tick retries", async () => {
    const db = getTestDb();
    const row = await briefingUser();
    const service = new DrizzleTaskService(db);
    await service.createTask(row.id, {
      title: "Sẽ thử lại",
      priority: "high",
      type: "work",
      dueAt: new Date("2026-08-19T02:00:00.000Z").toISOString(),
    });

    const result = await sendDailyBriefings({
      db,
      channel: {
        send: async () => {
          throw new Error("Telegram down");
        },
      },
      taskService: service,
      client: composingClient("briefing"),
      model: "test-model",
      now: AT_0730_BANGKOK,
    });

    expect(result.sent).toBe(0);
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(after?.lastBriefingOn).toBeNull();
  });
});
