import { describe, expect, it } from "vitest";
import { localMonth } from "./local-time.js";
import { computePace, describePace, formatMinutes } from "./pace.js";

/** 20 hours a month, the target the design was worked through with. */
const TARGET = 20 * 60;

describe("computePace", () => {
  it("stays quiet early in the month instead of reporting a disaster", () => {
    // Day 1 with nothing done is one day's share short, which is inside the
    // tolerance — the whole reason the comparison is pro-rata rather than
    // against the month's total (where this would read as 0 of 20 hours).
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: 0,
      dayOfMonth: 1,
      daysInMonth: 30,
    });

    expect(pace.expectedMinutes).toBe(40);
    expect(pace.status).toBe("on_track");
  });

  it("reports a deficit late in the month, not an impossible daily demand", () => {
    // Day 28 of 30 having done 9 of 20 hours: 18.7h was due, so the honest
    // number is "9.7h behind".
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: 9 * 60,
      dayOfMonth: 28,
      daysInMonth: 30,
    });

    expect(pace.expectedMinutes).toBe(1120);
    expect(pace.deltaMinutes).toBe(-580);
    expect(pace.status).toBe("behind");
  });

  it("counts today among the days left, so the last day asks for the whole remainder", () => {
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: TARGET - 45,
      dayOfMonth: 30,
      daysInMonth: 30,
    });

    expect(pace.suggestedTodayMinutes).toBe(45);
  });

  it("suggests the remainder spread over the days left", () => {
    // Half the month gone, a quarter of the target done: 15h left over 16 days.
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: 5 * 60,
      dayOfMonth: 15,
      daysInMonth: 30,
    });

    expect(pace.suggestedTodayMinutes).toBe(Math.ceil((TARGET - 300) / 16));
  });

  it("suggests nothing once the target is met, and never a negative", () => {
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: TARGET + 300,
      dayOfMonth: 20,
      daysInMonth: 30,
    });

    expect(pace.suggestedTodayMinutes).toBe(0);
    expect(pace.status).toBe("ahead");
  });

  it("scales the daily share to the actual length of the month", () => {
    const short = computePace({
      targetMinutes: TARGET,
      spentMinutes: 0,
      dayOfMonth: 14,
      daysInMonth: 28,
    });
    const long = computePace({
      targetMinutes: TARGET,
      spentMinutes: 0,
      dayOfMonth: 14,
      daysInMonth: 31,
    });

    // Halfway through February is half the target; the same date in a 31-day
    // month is slightly less.
    expect(short.expectedMinutes).toBe(TARGET / 2);
    expect(long.expectedMinutes).toBeLessThan(short.expectedMinutes);
  });

  it("treats a whole day's share as the tolerance in both directions", () => {
    const base = { targetMinutes: TARGET, dayOfMonth: 10, daysInMonth: 30 };
    const dailyShare = TARGET / 30;
    const expected = dailyShare * 10;

    expect(computePace({ ...base, spentMinutes: expected + dailyShare }).status).toBe("on_track");
    expect(computePace({ ...base, spentMinutes: expected - dailyShare }).status).toBe("on_track");
    expect(computePace({ ...base, spentMinutes: expected + dailyShare + 1 }).status).toBe("ahead");
    expect(computePace({ ...base, spentMinutes: expected - dailyShare - 1 }).status).toBe("behind");
  });

  it("never produces NaN from a degenerate month", () => {
    const pace = computePace({
      targetMinutes: TARGET,
      spentMinutes: 0,
      dayOfMonth: 0,
      daysInMonth: 0,
    });

    expect(Number.isFinite(pace.expectedMinutes)).toBe(true);
    expect(Number.isFinite(pace.suggestedTodayMinutes)).toBe(true);
  });
});

describe("localMonth", () => {
  it("resolves the month in the user's zone, not the host's", () => {
    // 23:30 UTC on 30 September is already 1 October in Bangkok (UTC+7), so
    // the two zones disagree about which month's target this minute counts to.
    const instant = new Date("2026-09-30T23:30:00Z");

    expect(localMonth(instant, "Asia/Bangkok")).toMatchObject({
      key: "2026-10",
      dayOfMonth: 1,
      daysInMonth: 31,
      firstDate: "2026-10-01",
      lastDate: "2026-10-31",
    });
    expect(localMonth(instant, "UTC")).toMatchObject({ key: "2026-09", dayOfMonth: 30 });
  });

  it("gets February right in a leap year", () => {
    expect(localMonth(new Date("2028-02-10T05:00:00Z"), "Asia/Bangkok")).toMatchObject({
      daysInMonth: 29,
      lastDate: "2028-02-29",
    });
  });
});

describe("formatMinutes", () => {
  it("reads as hours and minutes, not raw minutes", () => {
    expect(formatMinutes(125)).toBe("2h5m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(0)).toBe("0m");
  });

  it("never renders a negative", () => {
    expect(formatMinutes(-30)).toBe("0m");
  });
});

describe("describePace", () => {
  it("leads with how far behind, since that is what changes today's plan", () => {
    const line = describePace(
      "Học tiếng Anh",
      computePace({
        targetMinutes: TARGET,
        spentMinutes: 5 * 60,
        dayOfMonth: 14,
        daysInMonth: 30,
      }),
    );

    expect(line).toContain("Học tiếng Anh");
    expect(line).toContain("behind by");
    expect(line).toContain("suggest ~");
  });

  it("says on track without a misleading gap", () => {
    const line = describePace(
      "Gym",
      computePace({ targetMinutes: TARGET, spentMinutes: 320, dayOfMonth: 8, daysInMonth: 30 }),
    );

    expect(line).toContain("on track");
    expect(line).not.toContain("behind");
    expect(line).not.toContain("ahead");
  });
});
