import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  timezone: text("timezone").notNull().default("Asia/Bangkok"),
  telegramChatId: text("telegram_chat_id"),
  // Cursor for the inbound Notion->Postgres task sync (see
  // notion-sync.ts): the last_edited_time of the most recent Notion page
  // already applied, so each sync pass only re-fetches what changed since.
  notionSyncCursor: timestamp("notion_sync_cursor", { withTimezone: true }),
  // Morning briefing (see services/daily-briefing.ts), in the user's own
  // timezone above.
  briefingEnabled: boolean("briefing_enabled").notNull().default(true),
  briefingHour: integer("briefing_hour").notNull().default(7),
  briefingMinute: integer("briefing_minute").notNull().default(0),
  // The *local* calendar date of the last briefing sent, not a timestamp:
  // "have I already sent today's?" is a question about the user's day, and
  // storing the day directly makes the check idempotent without any
  // timezone arithmetic.
  lastBriefingOn: date("last_briefing_on", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: ["open", "in_progress", "done", "cancelled"] })
      .notNull()
      .default("open"),
    priority: text("priority", { enum: ["low", "medium", "high", "urgent"] })
      .notNull()
      .default("medium"),
    type: text("type", { enum: ["work", "personal", "chore"] })
      .notNull()
      .default("personal"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // Set only on the handful of tasks that are pursued at a *rate* rather
    // than finished once — "20 hours a month of English". Its presence is what
    // makes a task a routine: the pace figures are derived from it, and a task
    // without it has no pace at all. That absence is deliberately distinct from
    // a pace of zero, exactly as `progress: null` means "not broken down"
    // rather than "0% done". Nothing else about such a task differs — it keeps
    // its own work/personal/chore type (a gym routine is still "personal"),
    // and its status stays free so that flipping it to "open" is how a routine
    // gets paused.
    monthlyTargetMinutes: integer("monthly_target_minutes"),
    // A subtask points at its parent task; null for top-level tasks. Mirrors
    // the "Parent" relation in Notion. Cascades, so deleting a parent takes
    // its steps with it — a step has no meaning without the task it belongs
    // to. Only one level deep is expected in practice, though nothing here
    // enforces that.
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),
    // Set once a task is mirrored to/from Notion (see notion-sync.ts); null
    // for tasks that have never touched Notion.
    notionPageId: text("notion_page_id"),
    notionSyncedAt: timestamp("notion_synced_at", { withTimezone: true }),
    // The "done/total" checklist progress last written to this task's Notion
    // Progress property. Progress itself is always derived from child rows
    // (never stored); this only exists so the sync can skip redundant writes
    // — each write bumps the page's last_edited_time and would otherwise pull
    // the page back into the next sync pass for no reason.
    notionProgressPushed: text("notion_progress_pushed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    notionPageIdUnique: uniqueIndex("tasks_notion_page_id_idx")
      .on(table.notionPageId)
      .where(sql`${table.notionPageId} is not null`),
    parentIdx: index("tasks_parent_task_id_idx").on(table.parentTaskId),
  }),
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    timezone: text("timezone").notNull().default("Asia/Bangkok"),
    rrule: text("rrule"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["active", "paused", "completed", "cancelled"] })
      .notNull()
      .default("active"),
    // "auto" reminders are derived from a task's dueAt/priority (see
    // reminder-derivation.ts); "manual" ones come from the LLM agent tool.
    source: text("source", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    kind: text("kind", { enum: ["urgent_early", "early", "due", "overdue"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one *active* (not-yet-fired) auto reminder per (task, kind).
    // Scoped to status='active' rather than just kind-is-not-null: once a
    // reminder fires, the scheduler flips it to "completed" (see
    // scheduler/tick.ts) and it must stay there forever as an audit trail —
    // a later re-derive needs to be able to insert a fresh row for the same
    // (task, kind) without colliding with that historical one.
    taskKindActiveUnique: uniqueIndex("reminders_task_kind_active_idx")
      .on(table.taskId, table.kind)
      .where(sql`${table.kind} is not null and ${table.status} = 'active'`),
  }),
);

export const triggerRuns = pgTable(
  "trigger_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "processing", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("trigger_runs_idempotency_key_idx").on(table.idempotencyKey),
  }),
);

export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  triggerRunId: uuid("trigger_run_id").references(() => triggerRuns.id, {
    onDelete: "cascade",
  }),
  channel: text("channel", { enum: ["telegram"] }).notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: ["pending", "processing", "sent", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triggerRunId: uuid("trigger_run_id")
      .notNull()
      .references(() => triggerRuns.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["telegram"] }).notNull(),
    providerMessageId: text("provider_message_id"),
    status: text("status", { enum: ["sent", "failed"] }).notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    triggerChannelUnique: uniqueIndex("notification_deliveries_trigger_channel_idx").on(
      table.triggerRunId,
      table.channel,
    ),
  }),
);

/**
 * One chat thread, in the ChatGPT sense: the web app starts a new one per
 * "New chat", and Telegram starts one per /new.
 *
 * `channel` keeps the two surfaces apart — without it, Telegram's "continue
 * where I left off" would land in whatever thread the web app used last, which
 * is how the two used to bleed into each other. Threads stay listable across
 * both surfaces regardless of which one created them.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null until the first turn has been titled; the client falls back to
    // showing the opening message.
    title: text("title"),
    channel: text("channel", { enum: ["web", "telegram"] })
      .notNull()
      .default("web"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Last activity, not last edit — this is what both the thread list and
    // Telegram's "current thread" lookup order by.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userChannelActivityIdx: index("conversations_user_channel_updated_idx").on(
      table.userId,
      table.channel,
      table.updatedAt,
    ),
  }),
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    content: text("content"),
    // Raw OpenAI-shaped tool_calls array on an assistant message, if any.
    toolCalls: jsonb("tool_calls"),
    // Set on tool-role messages; must match the id in the assistant message's toolCalls.
    toolCallId: text("tool_call_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index("conversation_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["preference", "fact", "episodic"] }).notNull(),
    key: text("key").notNull(),
    content: text("content").notNull(),
    importance: integer("importance").notNull().default(50),
    confidence: integer("confidence").notNull().default(80),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    userKeyUnique: uniqueIndex("memories_user_key_idx").on(table.userId, table.key),
  }),
);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  runtime: text("runtime").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  toolCalls: jsonb("tool_calls").notNull().default(sql`'[]'::jsonb`),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
    .notNull()
    .default("pending"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A narrowly-scoped bearer credential for local desktop tools (Waybar,
// Vicinae, the CLI) that must read/complete tasks without ever holding
// WORKER_BFF_SHARED_SECRET. Only the raw token's sha256 hash is stored; the
// raw value is shown once at mint time and never persisted anywhere.
export const desktopTokens = pgTable("desktop_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One day's worth of deliberate work on a task: "today I'll spend an hour on
 * English". Sessions are never generated from a recurrence rule — they exist
 * only because the user picked that task for that day, from the desktop widget
 * or in chat. That is the whole reason there is no routine-definition table
 * here: there is no rule to store, no horizon to materialise ahead, and
 * nothing to clean up when the plan changes.
 *
 * Kept out of `tasks` on purpose. A task's subtasks are *steps* — units of the
 * thing being produced ("Chapter 1", "Chapter 2") — and progress counts them.
 * Sessions are units of *time spent*, so folding the two into one table would
 * make `done/total` add chapters to weekdays. Keeping them apart also means
 * the two rules steps obey ("a step has no due date of its own", "a step never
 * appears in the Now view as its own entry") stay true as written, instead of
 * each growing an "unless it is a session" branch.
 */
export const workSessions = pgTable(
  "work_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The goal the time is being spent on. Always a top-level task in
    // practice; nothing here enforces that.
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // The user's local calendar day, not a timestamp: "have I already planned
    // this task today?" is a question about *their* day, and storing the day
    // directly answers it with no timezone arithmetic. Same reasoning as
    // users.last_briefing_on.
    date: date("date", { mode: "string" }).notNull(),
    // Only set when the session is meant to happen at a particular time. Two
    // consequences: it is what earns the session a reminder, and it is what
    // makes it render as a time block rather than an all-day item on a
    // calendar. A session without it is still a real commitment for the day.
    startAt: timestamp("start_at", { withTimezone: true }),
    plannedMinutes: integer("planned_minutes").notNull(),
    // Null until the session is closed out. On completion an omitted value
    // falls back to plannedMinutes — that is what makes simply ticking a
    // session off count as having spent the time committed to, while still
    // allowing "I only managed 20 minutes" to be recorded honestly.
    actualMinutes: integer("actual_minutes"),
    // "skipped" is a deliberate pass and is excluded from the pace numerator;
    // a "planned" session whose day has gone by is a miss. The distinction
    // only survives because sessions are never deleted — delete the misses
    // and adherence reads 100% forever.
    status: text("status", { enum: ["planned", "done", "skipped"] })
      .notNull()
      .default("planned"),
    // The one reminder a session gets, when it was given a start time. Held
    // here rather than as a column on `reminders` so that table — the most
    // reliability-critical one in the app — needs no change at all: a session
    // reminder is an ordinary manual reminder on the parent task, and rides
    // the existing trigger_run/outbox pipeline untouched. Nulled rather than
    // cascaded on delete, since losing a reminder must not take the record of
    // the work with it.
    reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "set null" }),
    notionPageId: text("notion_page_id"),
    notionSyncedAt: timestamp("notion_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one session per task per day, so "how long did I spend on this
    // today" stays a single number to read and a single row to edit. Splitting
    // a day into a morning and an evening block would mean dropping this and
    // summing instead.
    taskDateUnique: uniqueIndex("work_sessions_task_date_idx").on(table.taskId, table.date),
    // Drives both "what did I pick for today" and the month window the pace
    // figures are computed over.
    userDateIdx: index("work_sessions_user_date_idx").on(table.userId, table.date),
    notionPageIdUnique: uniqueIndex("work_sessions_notion_page_id_idx")
      .on(table.notionPageId)
      .where(sql`${table.notionPageId} is not null`),
  }),
);
