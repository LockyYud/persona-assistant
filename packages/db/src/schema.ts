import { sql } from "drizzle-orm";
import {
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

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
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
