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

/**
 * A top-level task plus the two things derived from its subtasks: how many
 * are finished, and which step to do next.
 */
export interface TaskWithProgress extends Task {
  progress: TaskProgress | null;
  /** Earliest-created subtask that isn't done/cancelled yet, if any. */
  nextStep: Task | null;
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
  nextUp: TaskWithProgress | null;
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
