import type { Pace, PaceStatus } from "@persona/core";

/**
 * How a routine task's month is going. Pure, because this is the part most
 * likely to be subtly wrong — the same reason reminder-derivation keeps its
 * offset arithmetic testable on its own.
 */
export interface PaceInput {
  /** The task's monthlyTargetMinutes. */
  targetMinutes: number;
  /** Minutes credited so far this calendar month. */
  spentMinutes: number;
  /** 1-based day of the user's local month, and how long that month is. */
  dayOfMonth: number;
  daysInMonth: number;
}

/**
 * Landing exactly on the pro-rata share to the minute never happens, so
 * without a tolerance the status would flip between "ahead" and "behind"
 * every single day and stop meaning anything. One day's share of the target
 * is the natural grain: it is the smallest gap you can actually close, and
 * being a whole day's worth off is real information rather than noise.
 */
function statusFor(deltaMinutes: number, dailyShareMinutes: number): PaceStatus {
  if (deltaMinutes > dailyShareMinutes) return "ahead";
  if (deltaMinutes < -dailyShareMinutes) return "behind";
  return "on_track";
}

export function computePace(input: PaceInput): Pace {
  const { targetMinutes, spentMinutes } = input;
  // Guard the divisors rather than trusting callers: a zero here would turn
  // every field downstream into NaN, which reads as a plausible number in
  // JSON and would be far harder to notice than a wrong one.
  const daysInMonth = Math.max(1, input.daysInMonth);
  const dayOfMonth = Math.min(Math.max(1, input.dayOfMonth), daysInMonth);

  const dailyShareMinutes = targetMinutes / daysInMonth;
  const expectedMinutes = Math.round(dailyShareMinutes * dayOfMonth);
  const deltaMinutes = spentMinutes - expectedMinutes;

  // Today counts as one of the days left, so today's suggestion is the share
  // of the remainder that includes it — on the last day of the month that
  // makes the suggestion the entire remaining deficit, which is correct.
  const daysLeft = daysInMonth - dayOfMonth + 1;
  const remainingMinutes = Math.max(0, targetMinutes - spentMinutes);

  return {
    targetMinutes,
    spentMinutes,
    expectedMinutes,
    deltaMinutes,
    status: statusFor(deltaMinutes, dailyShareMinutes),
    dayOfMonth,
    daysInMonth,
    suggestedTodayMinutes: Math.ceil(remainingMinutes / daysLeft),
  };
}

/**
 * Compact durations: "1h45m", "45m", "2h". Minutes are the unit everything
 * here is stored and reasoned in, but nobody reads "125 minutes" as fluently
 * as "2h5m" — and this is the form that goes into prompts and briefings, where
 * the model and the reader both do better with hours.
 */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h${rest}m`;
}

/**
 * One line summarising a routine's month, shared by the agent's system prompt
 * and the morning briefing so the two never describe the same state
 * differently.
 *
 * It leads with what is behind or ahead rather than the raw totals, because
 * that is the part that decides whether today needs more time than planned.
 */
export function describePace(title: string, pace: Pace): string {
  const spent = formatMinutes(pace.spentMinutes);
  const target = formatMinutes(pace.targetMinutes);
  const gap = formatMinutes(Math.abs(pace.deltaMinutes));

  const standing =
    pace.status === "behind"
      ? `behind by ${gap}`
      : pace.status === "ahead"
        ? `ahead by ${gap}`
        : "on track";

  return (
    `${title}: ${spent} of ${target} this month, ${standing} ` +
    `(day ${pace.dayOfMonth}/${pace.daysInMonth}); suggest ~${formatMinutes(pace.suggestedTodayMinutes)} today`
  );
}
