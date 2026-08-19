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
  notionPageId: string | null;
  createdAt: Date;
  updatedAt: Date;
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

/** Buckets used by the "Now" task view and every desktop touch point. */
export interface NowTasks {
  overdue: Task[];
  today: Task[];
  nextUp: Task | null;
  /** Open tasks with no dueAt at all — never dropped silently. */
  unscheduledCount: number;
  /** The unscheduled tasks themselves, oldest first, capped — see UNSCHEDULED_LIST_CAP. */
  unscheduled: Task[];
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
