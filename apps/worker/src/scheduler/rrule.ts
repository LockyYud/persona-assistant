import { RRule } from "rrule";

/**
 * Computes the next occurrence strictly after `after`, interpreting the RRULE
 * string as wall-clock time in `timezone`. RRULE itself is timezone-naive, so
 * we treat DTSTART/occurrences as UTC instants that already encode the
 * intended local time (the reminder is created with nextRunAt already
 * converted to UTC by the caller).
 */
export function computeNextOccurrence(rruleText: string, after: Date): Date | null {
  const rule = RRule.fromString(rruleText);
  const next = rule.after(after, false);
  return next ?? null;
}
