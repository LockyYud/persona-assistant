import rrulePkg from "rrule";

// rrule ships as CommonJS; Node's ESM interop only exposes it as the default
// export (cjs-module-lexer can't statically detect its named exports), so we
// have to destructure at runtime instead of using a named import.
const { RRule } = rrulePkg;

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
