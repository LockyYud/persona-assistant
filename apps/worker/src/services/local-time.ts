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
