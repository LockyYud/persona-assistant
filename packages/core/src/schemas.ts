import { z } from "zod";

export const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const taskTypeSchema = z.enum(["work", "personal", "chore"]);

/** Capped at the minutes in a 31-day month; beyond that it is a typo. */
export const monthlyTargetMinutesSchema = z.number().int().min(1).max(31 * 24 * 60);

/** A local calendar day, YYYY-MM-DD — the form work_sessions.date stores. */
export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** One day's worth of work, so a whole day is the ceiling. */
const sessionMinutesSchema = z.number().int().min(1).max(24 * 60);
const focusTextSchema = z.string().trim().min(1).max(280);

export const createTaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: taskPrioritySchema.default("medium"),
  type: taskTypeSchema.default("personal"),
  dueAt: z.string().datetime().optional(),
  /**
   * Setting this is what makes the task a routine — one pursued at a rate
   * ("20 hours a month") rather than finished once. Leave it off for ordinary
   * tasks; there is no separate type or flag to set.
   */
  monthlyTargetMinutes: monthlyTargetMinutesSchema.optional(),
  /** Makes the new task a step of an existing one. */
  parentTaskId: z.string().uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  type: taskTypeSchema.optional(),
  dueAt: z.string().datetime().nullable().optional(),
  /** Pass null to stop treating the task as a routine; its sessions survive. */
  monthlyTargetMinutes: monthlyTargetMinutesSchema.nullable().optional(),
  /** Pass null to promote a subtask back to a top-level task. */
  parentTaskId: z.string().uuid().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** Read-only: asks the LLM to propose steps, creates nothing. */
export const proposeTaskBreakdownInputSchema = z.object({
  taskId: z.string().uuid(),
  /** Anything the user said that should steer the breakdown. */
  context: z.string().max(2000).optional(),
});
export type ProposeTaskBreakdownInput = z.infer<typeof proposeTaskBreakdownInputSchema>;

/**
 * Creates the steps. Deliberately takes explicit titles rather than a task id
 * to re-derive them from: this tool needs user confirmation, and the approval
 * payload must be exactly the list the user was shown — re-running a
 * generation step at approval time could produce different steps than the
 * ones they agreed to.
 */
export const createSubtasksInputSchema = z.object({
  parentTaskId: z.string().uuid(),
  titles: z.array(z.string().min(1).max(200)).min(1).max(20),
});
export type CreateSubtasksInput = z.infer<typeof createSubtasksInputSchema>;

export const completeTaskInputSchema = z.object({
  taskId: z.string().uuid(),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

export const listTasksInputSchema = z.object({
  status: taskStatusSchema.optional(),
});
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export const createReminderInputSchema = z.object({
  taskId: z.string().uuid(),
  message: z.string().min(1).max(500),
  timezone: z.string().min(1).default("Asia/Bangkok"),
  rrule: z.string().optional(),
  nextRunAt: z.string().datetime(),
});
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>;

export const conversationChannelSchema = z.enum(["web", "telegram"]);

export const chatInputSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  /** Which surface the message came from; threads are kept separate per channel. */
  channel: conversationChannelSchema.default("web"),
  /**
   * Forces a fresh thread even if the caller could have continued one — this
   * is what "New chat" sends, and it must be explicit: omitting a
   * conversationId means "continue where I left off", not "start over".
   */
  startNewConversation: z.boolean().optional(),
});
export type ChatInput = z.infer<typeof chatInputSchema>;

export const internalTickSignatureHeaders = z.object({
  "x-signature": z.string(),
  "x-timestamp": z.string(),
});

/**
 * Turning a task into a routine, or back into an ordinary one.
 *
 * Its own input rather than a use of updateTask because the desktop token is
 * deliberately narrow: it may read tasks, complete them, snooze them and move
 * them between the two working statuses, and nothing else. Designating a
 * routine is the one further thing the panel needs, so it gets one endpoint
 * that does exactly that instead of opening the full task-update surface to a
 * credential that sits in a file on a laptop.
 */
export const setRoutineTargetInputSchema = z.object({
  taskId: z.string().uuid(),
  /** Null stops treating the task as a routine; its sessions are untouched. */
  monthlyTargetMinutes: monthlyTargetMinutesSchema.nullable(),
});
export type SetRoutineTargetInput = z.infer<typeof setRoutineTargetInputSchema>;

export const workSessionStatusSchema = z.enum(["planned", "done", "skipped"]);

/**
 * Commits a stretch of today (or another day) to one task. Idempotent per
 * (task, day): planning the same task again for the same day revises that
 * session rather than failing, which is what "actually make it 90 minutes"
 * has to mean when there can only be one session per task per day.
 */
export const planSessionInputSchema = z.object({
  taskId: z.string().uuid(),
  /** Defaults to the user's own today, resolved in their timezone. */
  date: dateKeySchema.optional(),
  plannedMinutes: sessionMinutesSchema,
  /** Omit to retain an existing focus; null explicitly clears it. */
  focusText: focusTextSchema.nullable().optional(),
  /** Only for a session meant to happen at a set time; earns it a reminder. */
  startAt: z.string().datetime().optional(),
});
export type PlanSessionInput = z.infer<typeof planSessionInputSchema>;

/** A proposed commitment in the one-click Today plan shown in Telegram. */
export const planTodayItemInputSchema = z.object({
  taskId: z.string().uuid(),
  focusText: focusTextSchema.nullable().optional(),
  plannedMinutes: sessionMinutesSchema,
  startAt: z.string().datetime().optional(),
});

/** Plans several distinct top-level tasks for the user's local current day. */
export const planTodayInputSchema = z
  .object({ items: z.array(planTodayItemInputSchema).min(1).max(12) })
  .superRefine(({ items }, ctx) => {
    const ids = new Set<string>();
    let total = 0;
    for (const [index, item] of items.entries()) {
      if (ids.has(item.taskId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "taskId"], message: "task may appear only once" });
      }
      ids.add(item.taskId);
      total += item.plannedMinutes;
    }
    if (total > 24 * 60) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "planned minutes exceed one day" });
    }
  });
export type PlanTodayInput = z.infer<typeof planTodayInputSchema>;

/**
 * Closes a session out as done. Omitting actualMinutes credits the minutes
 * committed to — ticking a session off is the common case and should not
 * require typing a number — while passing one records what really happened.
 */
export const completeSessionInputSchema = z.object({
  sessionId: z.string().uuid(),
  actualMinutes: sessionMinutesSchema.optional(),
});
export type CompleteSessionInput = z.infer<typeof completeSessionInputSchema>;

/**
 * A deliberate pass, which is excluded from the pace numerator. Distinct from
 * simply letting the day go by: that leaves the session "planned" and counts
 * as a miss.
 */
export const skipSessionInputSchema = z.object({
  sessionId: z.string().uuid(),
});
export type SkipSessionInput = z.infer<typeof skipSessionInputSchema>;

/** Inclusive date range; both ends optional. */
export const listSessionsInputSchema = z.object({
  taskId: z.string().uuid().optional(),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});
export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>;
