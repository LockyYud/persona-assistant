import { describe, expect, it } from "vitest";
import { computeNextOccurrence } from "./rrule.js";

describe("computeNextOccurrence", () => {
  it("returns the next daily occurrence after the given time", () => {
    const rruleText = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY";
    const after = new Date("2026-01-01T09:00:00Z");

    const next = computeNextOccurrence(rruleText, after);

    expect(next?.toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  it("returns null once the recurrence has no further occurrences", () => {
    const rruleText = "DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2";
    const after = new Date("2026-01-02T09:00:00Z");

    const next = computeNextOccurrence(rruleText, after);

    expect(next).toBeNull();
  });
});
