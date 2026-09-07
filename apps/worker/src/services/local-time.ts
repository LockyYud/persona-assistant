/**
 * Everything time-of-day in this app is relative to the *user's* timezone,
 * never the server's — the worker runs in UTC on a host in another region, so
 * "today" and "7am" only mean anything once resolved against a timezone.
 */

/** The user's local calendar day as YYYY-MM-DD (en-CA formats exactly that way). */
export function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

/**
 * Minutes since local midnight, so a wall-clock target like 07:00 can be
 * compared without constructing dates in another zone.
 */
export function minutesSinceMidnightInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  // en-GB renders midnight as "24" in some runtimes; normalise it to 0 so the
  // value is always in [0, 1440).
  return (hour % 24) * 60 + minute;
}

/** Where a moment falls in the user's local month — the pace window. */
export interface LocalMonth {
  /** YYYY-MM. */
  key: string;
  /** 1-based. */
  dayOfMonth: number;
  daysInMonth: number;
  /** Inclusive YYYY-MM-DD bounds, for range-querying the date column. */
  firstDate: string;
  lastDate: string;
}

/**
 * Resolves the calendar month containing `date` in the user's timezone.
 *
 * The calendar month, rather than a rolling 30 days, because that is the
 * window a monthly target is stated in ("20 hours a month") — keeping the two
 * the same means the number shown never has to be reconciled with the number
 * asked for.
 */
export function localMonth(date: Date, timezone: string): LocalMonth {
  const key = dateKeyInTimezone(date, timezone);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  // Day 0 of the following month is the last day of this one. Built through
  // Date.UTC so the *host's* zone can never shift the answer.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthKey = key.slice(0, 7);

  return {
    key: monthKey,
    dayOfMonth: Number(key.slice(8, 10)),
    daysInMonth,
    firstDate: `${monthKey}-01`,
    lastDate: `${monthKey}-${String(daysInMonth).padStart(2, "0")}`,
  };
}
