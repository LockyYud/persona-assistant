import { describe, expect, it } from "vitest";
import { describeNow, utcOffsetInTimezone } from "./local-time.js";

describe("describeNow", () => {
  it("uses the user's local date when UTC is still the previous day", () => {
    // Sun 2026-10-04 19:00 UTC = Mon 2026-10-05 02:00 in Bangkok.
    const text = describeNow(new Date("2026-10-04T19:00:00Z"), "Asia/Bangkok");
    expect(text).toContain("Monday 2026-10-05 02:00");
    expect(text).toContain("UTC+07:00");
    expect(text).toContain("tomorrow: Tuesday 2026-10-06");
    expect(text).toContain("+7d: Monday 2026-10-12");
  });

  it("reports offsets for other zones", () => {
    expect(utcOffsetInTimezone(new Date("2026-10-04T00:00:00Z"), "America/New_York")).toBe("-04:00");
    expect(utcOffsetInTimezone(new Date("2026-10-04T00:00:00Z"), "UTC")).toBe("+00:00");
  });
});
