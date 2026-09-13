export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskType = "work" | "personal" | "chore";

export interface Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  dueAt: Date | null;
  /**
   * Minutes targeted per calendar month, for a task pursued at a rate rather
   * than finished once. Null on ordinary tasks — and that null is what makes
   * `pace` null too, just as a task with no subtasks has no `progress`.
   */
  monthlyTargetMinutes: number | null;
  /** Set on a subtask (a step of another task); null for top-level tasks. */
  parentTaskId: string | null;
  notionPageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How far along a task is, counted from its subtasks. Only ever present for
 * a task that actually has subtasks — a task with no steps has no progress
 * to report, which is deliberately different from being 0% done.
 */
export interface TaskProgress {
  done: number;
  total: number;
}

export type PaceStatus = "ahead" | "on_track" | "behind";

/**
 * How a routine task is doing against its monthly target, over the *calendar*
 * month — the window the target is stated in ("20 hours a month"), so the two
 * never need reconciling.
 *
 * The comparison is against `expectedMinutes`, the pro-rata share due by the
 * end of today, rather than against the month's total. Comparing to the total
 * makes the figure useless at both ends of the month: 0 of 20 hours on the 2nd
 * looks like a disaster, and being 10 hours short on the 28th turns into a
 * demand for 3.3 hours a day. Against the pro-rata share the 2nd stays quiet
 * and the 28th reports "10 hours behind" — a fact you can act on.
 */
export interface Pace {
  /** The task's monthlyTargetMinutes, copied here so callers need only this. */
  targetMinutes: number;
  /** Spent so far this month: actualMinutes where set, else plannedMinutes. */
  spentMinutes: number;
  /** The pro-rata share of the target due by the end of today. */
  expectedMinutes: number;
  /** spentMinutes - expectedMinutes. Negative means behind. */
  deltaMinutes: number;
  status: PaceStatus;
  /** 1-based day of the user's local month, and how long that month is. */
  dayOfMonth: number;
  daysInMonth: number;
  /**
   * What to put in today to land on target by month end, spreading whatever is
   * left over the days left (today included). Zero once the target is met —
   * this is the number the widget and the briefing suggest.
   */
  suggestedTodayMinutes: number;
}

/**
 * A top-level task plus what is derived from its children: how many steps are
 * finished, which step to do next, and — for a routine task — how its month is
 * going.
 */
export interface TaskWithProgress extends Task {
  progress: TaskProgress | null;
  /** Earliest-created subtask that isn't done/cancelled yet, if any. */
  nextStep: Task | null;
  /**
   * Null unless the task carries a monthlyTargetMinutes. Distinct from a pace
   * of zero: "not a routine" is not "a routine with nothing done".
   */
  pace: Pace | null;
}

export type WorkSessionStatus = "planned" | "done" | "skipped";

/**
 * One day's committed work on a task. Created only because the user picked
 * that task for that day — never generated from a recurrence rule.
 */
export interface WorkSession {
  id: string;
  userId: string;
  taskId: string;
  /** The user's local calendar day, YYYY-MM-DD. */
  date: string;
  startAt: Date | null;
  /** What the user intends to focus on during this day's commitment. */
  focusText: string | null;
  plannedMinutes: number;
  /** Null while still planned; on completion it defaults to plannedMinutes. */
  actualMinutes: number | null;
  status: WorkSessionStatus;
  /**
   * The one reminder this session earned by having a start time, if any. An
   * ordinary manual reminder on the parent task — see session-reminders.ts for
   * why it is tracked from this side.
   */
  reminderId: string | null;
  notionPageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A session with the task it belongs to, for "what am I doing today". */
export interface WorkSessionWithTask extends WorkSession {
  task: Task;
}

export type ReminderStatus = "active" | "paused" | "completed" | "cancelled";
export type ReminderSource = "manual" | "auto";
export type ReminderKind = "urgent_early" | "early" | "due" | "overdue";

export interface Reminder {
  id: string;
  taskId: string;
  userId: string;
  message: string;
  timezone: string;
  rrule: string | null;
  nextRunAt: Date;
  status: ReminderStatus;
  source: ReminderSource;
  kind: ReminderKind | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Buckets used by the "Now" task view and every desktop touch point.
 *
 * Subtasks never appear as entries in their own right — a step only makes
 * sense next to the task it belongs to, so each bucket holds top-level tasks
 * and carries the step to do next alongside them.
 */
export interface NowTasks {
  overdue: TaskWithProgress[];
  today: TaskWithProgress[];
  /**
   * The single soonest future-dated task, or null when anything is already
   * overdue or due today. Kept as its own field because callers that group by
   * schedule (the daily briefing, the web list) present it as one highlighted
   * "next up" line rather than as a list.
   */
  nextUp: TaskWithProgress | null;
  /**
   * Every task due after today, soonest first, capped — see FUTURE_LIST_CAP.
   * `nextUp` is this list's first entry when it is set, so a caller that
   * groups by *status* rather than by schedule can read `future` alone and
   * not silently lose a task it should have shown. Grouping by schedule
   * should keep using `nextUp`.
   */
  future: TaskWithProgress[];
  /**
   * Routine tasks actively being pursued (`in_progress` and carrying a monthly
   * target), each with its `pace` set. They are held apart from the dueAt
   * buckets because a routine has no deadline to sort by, and — more
   * importantly — apart from `unscheduled`: a routine has no dueAt, so it
   * would otherwise sit in the "not scheduled yet" pile forever, which is
   * precisely backwards for the tasks worked on most consistently.
   *
   * A routine flipped to `open` is a paused one: it appears in no bucket and
   * accrues no pace, which is the whole mechanism for pausing one.
   */
  ongoing: TaskWithProgress[];
  /** Open tasks with no dueAt at all — never dropped silently. */
  unscheduledCount: number;
  /** The unscheduled tasks themselves, oldest first, capped — see UNSCHEDULED_LIST_CAP. */
  unscheduled: TaskWithProgress[];
}

export interface DesktopToken {
  id: string;
  userId: string;
  label: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type TriggerRunStatus = "pending" | "processing" | "completed" | "failed";

export interface TriggerRun {
  id: string;
  reminderId: string;
  idempotencyKey: string;
  scheduledFor: Date;
  status: TriggerRunStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OutboxStatus = "pending" | "processing" | "sent" | "failed";

export interface OutboxRecord {
  id: string;
  triggerRunId: string | null;
  channel: "telegram";
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  availableAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DeliveryStatus = "sent" | "failed";

export interface NotificationDelivery {
  id: string;
  triggerRunId: string;
  channel: "telegram";
  providerMessageId: string | null;
  status: DeliveryStatus;
  error: string | null;
  createdAt: Date;
}

export interface AgentRun {
  id: string;
  userId: string;
  runtime: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  toolCalls: Record<string, unknown>[];
  error: string | null;
  createdAt: Date;
}

export interface User {
  id: string;
  email: string;
  timezone: string;
  telegramChatId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
