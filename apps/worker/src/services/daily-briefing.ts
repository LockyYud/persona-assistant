import type OpenAI from "openai";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotificationChannel } from "@persona/integrations";
import type { NowTasks, TaskService, TaskWithProgress } from "@persona/core";
import { dateKeyInTimezone, minutesSinceMidnightInTimezone } from "./local-time.js";
import { describePace, formatMinutes } from "./pace.js";

/**
 * How late a briefing may still be sent. The tick is not guaranteed to run at
 * the target minute — the worker's instance can be asleep, or a scheduler
 * invocation can fail — so a missed target is caught up on the next tick. Past
 * this window the day is skipped entirely rather than delivering a "here's
 * your morning" at dinner time.
 */
const CATCH_UP_WINDOW_MINUTES = 4 * 60;

const BRIEFING_PROMPT = `You write a short morning briefing about someone's day, and propose a plan.

You are given the real data. Rules:
- Never invent a task, a count, a deadline or a number of minutes that is not in the data.
- Open with one sentence on what deserves attention first, and why (most overdue,
  or nearest deadline, or furthest behind its monthly pace) — this is the part that
  earns the message.
- Then list the tasks compactly. Keep the whole thing under 12 lines.
- Where a task shows step progress, mention the next step rather than the count alone.
- The "Routine" section lists things pursued at a rate per month, each with how far
  behind or ahead it is and a suggested length for today. Propose today's plan from
  those suggestions — offer the numbers given, never your own. Close by inviting him
  to reply with what he picks.
- Write in Vietnamese, second person, plain and calm. No greeting boilerplate, no
  emoji spam (at most a couple), no motivational filler.

Reply with JSON only: {"text":"..."}`;

export interface BriefingUser {
  timezone: string;
  briefingEnabled: boolean;
  briefingHour: number;
  briefingMinute: number;
  lastBriefingOn: string | null;
  telegramChatId: string | null;
}

/**
 * Whether this user is due a briefing right now. Pure so the timing rules —
 * the part most likely to be subtly wrong — can be tested directly.
 */
export function isBriefingDue(user: BriefingUser, now: Date): boolean {
  if (!user.briefingEnabled || !user.telegramChatId) return false;

  const today = dateKeyInTimezone(now, user.timezone);
  // Already sent for the user's current local day.
  if (user.lastBriefingOn === today) return false;

  const target = user.briefingHour * 60 + user.briefingMinute;
  const localMinutes = minutesSinceMidnightInTimezone(now, user.timezone);
  if (localMinutes < target) return false;

  return localMinutes - target <= CATCH_UP_WINDOW_MINUTES;
}

/**
 * Whether there is anything worth interrupting for. A daily "nothing due
 * today" message would train the reader to ignore the channel, which costs
 * more than it gives on the days something is actually wrong — so a quiet day
 * stays quiet. Backlog with no deadline is not a reason to send.
 */
export function hasBriefingContent(now: NowTasks): boolean {
  // A routine slipping behind its month is worth interrupting for: it is
  // exactly the failure nothing else in the app would ever raise, since a
  // routine has no deadline to go overdue against. Being on track or ahead is
  // not — a morning message that says "all fine" every day is how a channel
  // gets ignored.
  const behind = now.ongoing.some((task) => task.pace?.status === "behind");
  return now.overdue.length > 0 || now.today.length > 0 || behind;
}

/**
 * A routine's line: where its month stands, and what to offer for today. The
 * wording comes from describePace so the briefing and the chat agent never
 * describe the same state differently.
 */
function describeRoutine(task: TaskWithProgress): string {
  return `- ${describePace(task.title, task.pace!)}`;
}

function describeTask(task: TaskWithProgress): string {
  const bits: string[] = [task.title];
  if (task.progress) bits.push(`${task.progress.done}/${task.progress.total} bước`);
  if (task.nextStep) bits.push(`tiếp: ${task.nextStep.title}`);
  bits.push(task.priority);
  return `- ${bits.join(" · ")}`;
}

/**
 * The plain rendering of the data. Doubles as the prompt input and as the
 * fallback when the model call fails — a briefing must still arrive even if
 * the nicer wording doesn't.
 */
export function renderBriefing(now: NowTasks): string {
  const sections: string[] = [];

  if (now.overdue.length > 0) {
    sections.push(`Quá hạn (${now.overdue.length}):\n${now.overdue.map(describeTask).join("\n")}`);
  }
  if (now.today.length > 0) {
    sections.push(`Hôm nay (${now.today.length}):\n${now.today.map(describeTask).join("\n")}`);
  }
  if (now.nextUp) {
    sections.push(`Sắp tới:\n${describeTask(now.nextUp)}`);
  }
  const paced = now.ongoing.filter((task) => task.pace !== null);
  if (paced.length > 0) {
    // Furthest behind first — listNowTasks already orders them that way, so the
    // model sees the one most needing today's time at the top.
    const total = paced.reduce((sum, task) => sum + (task.pace?.suggestedTodayMinutes ?? 0), 0);
    sections.push(
      `Routine (${paced.length}):\n${paced.map(describeRoutine).join("\n")}\n` +
        `Tổng đề xuất hôm nay: ${formatMinutes(total)}.`,
    );
  }
  if (now.unscheduledCount > 0) {
    sections.push(`+ ${now.unscheduledCount} task chưa có hạn.`);
  }

  return sections.join("\n\n");
}

/**
 * Asks the model to turn the rendered data into prose with a recommendation.
 * Returns null on any failure, including output that doesn't parse — the
 * caller falls back to the plain rendering rather than skipping the day.
 */
export async function composeBriefing(
  client: OpenAI,
  model: string,
  rendered: string,
): Promise<string | null> {
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: BRIEFING_PROMPT },
        { role: "user", content: rendered },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const text = (JSON.parse(raw) as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

export interface DailyBriefingDeps {
  db: Database;
  channel: NotificationChannel;
  taskService: TaskService;
  client: OpenAI;
  model: string;
  now?: Date;
}

/**
 * Sends each user their morning briefing, at most once per local day.
 *
 * Deliberately not routed through the reminder/outbox pipeline: that path is
 * task-scoped end to end (reminders.taskId, trigger_runs.reminderId and the
 * chat-id resolver all require a task), and loosening it for a message that
 * belongs to no task would mean editing the most reliability-critical code in
 * the app. The trade is no backoff or dead-lettering here; instead
 * lastBriefingOn is written only after a successful send, so a failure simply
 * retries on the next tick.
 */
export async function sendDailyBriefings(
  deps: DailyBriefingDeps,
): Promise<{ sent: number; skipped: number }> {
  const now = deps.now ?? new Date();
  const users = await deps.db.select().from(schema.users);

  let sent = 0;
  let skipped = 0;

  for (const user of users) {
    if (!isBriefingDue(user, now)) continue;

    try {
      const nowTasks = await deps.taskService.listNowTasks(user.id);

      if (!hasBriefingContent(nowTasks)) {
        // Mark the day done anyway, so a quiet morning isn't re-evaluated on
        // every tick for the rest of the catch-up window.
        await markBriefingSent(deps.db, user.id, dateKeyInTimezone(now, user.timezone));
        skipped += 1;
        continue;
      }

      const rendered = renderBriefing(nowTasks);
      const text = (await composeBriefing(deps.client, deps.model, rendered)) ?? rendered;

      await deps.channel.send({ chatId: user.telegramChatId as string, text });
      await markBriefingSent(deps.db, user.id, dateKeyInTimezone(now, user.timezone));
      sent += 1;
    } catch (error) {
      // Left unmarked on purpose: the next tick inside the window retries.
      console.error(`Daily briefing failed for user ${user.id}:`, error);
    }
  }

  return { sent, skipped };
}

async function markBriefingSent(db: Database, userId: string, localDate: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ lastBriefingOn: localDate })
    .where(eq(schema.users.id, userId));
}
