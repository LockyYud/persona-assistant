# Persona Assistant

Single-user MVP: web chat (Next.js/Vercel), worker/agent (Fastify/Render),
Postgres (Supabase), Telegram as both an outbound notification channel and an
interactive chat channel. See the strategy doc in the repo root for the full
plan this implements (Telegram-as-chat is an extension beyond that plan's
original "delivery-only" scope).

## Layout

- `apps/web` — Next.js App Router, Auth.js Credentials (single password, no
  OAuth), chat + tasks UI, BFF routes that call the worker with a shared
  secret.
- `apps/worker` — Fastify API: `/chat`, `/tasks`, `/tasks/:taskId`,
  `/internal/tick`, `/telegram/webhook`, `/approvals/:id/decision`,
  `/auth/verify-password`, `/health`, `/users/me`. Owns the LLM adapter,
  task/reminder services, and the outbox/scheduler tick logic.
- `apps/scheduler-lambda` — Lambda invoked every minute by a live EventBridge
  Scheduler; HMAC-signs an empty body and calls `/internal/tick`.
- `packages/core` — domain types, Zod schemas, `TaskService`/`ReminderService`/
  `AgentRuntime` interfaces.
- `packages/db` — Drizzle schema + migrations, via `pg` (works against
  Supabase, Neon, Render Postgres, or any standard Postgres host).
- `packages/integrations` — Telegram Bot API client + onboarding helper.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, secrets, AUTH_PASSWORD_HASH, Telegram/LLM keys
pnpm --filter @persona/db generate   # already run once; re-run after schema changes
pnpm --filter @persona/db migrate    # applies packages/db/drizzle/*.sql to DATABASE_URL
pnpm --filter @persona/worker seed   # inserts the allowlisted user row
pnpm --filter @persona/worker exec tsx src/scripts/telegram-onboarding.ts duy.dm@teko.vn  # links Telegram chat_id

pnpm dev:worker   # http://localhost:8787
pnpm dev:web      # http://localhost:3000
```

## Registering the Telegram webhook

Once `TELEGRAM_WEBHOOK_SECRET` is set on the deployed worker, point Telegram
at it (one-time, run from anywhere with curl):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<worker>.onrender.com/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
```

## What's implemented

- Full task/reminder domain, Zod-validated tool inputs, Drizzle schema for all
  eight tables in the plan (`approval_requests` is schema-only, unused by MVP
  code paths per the plan).
- Outbox dispatcher: lease-based recovery, `FOR UPDATE SKIP LOCKED` claiming,
  idempotent trigger-run creation (unique `idempotency_key`), exponential
  backoff up to 5 attempts, RRULE-based `next_run_at` recomputation.
- HMAC-signed `/internal/tick` with timestamp skew check and raw-body
  signature verification (custom content-type parser preserves exact bytes).
- `OpenAICompatibleAgentAdapter` implementing the runtime-agnostic
  `AgentRuntime` interface via any OpenAI-compatible Chat Completions API
  (OpenAI, DeepSeek, Gemini's OpenAI-compat endpoint, OpenRouter, ...),
  configured purely through `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` env
  vars — switching providers is a config change, not a code change. Reminders
  are delivered deterministically through the outbox, never through the LLM.
- **Single-password login**, no OAuth. Auth.js Credentials provider posts to
  the worker's `POST /auth/verify-password`, which compares against a bcrypt
  hash (`AUTH_PASSWORD_HASH`, plaintext never stored anywhere) and rate-limits
  by IP: 5 failed attempts locks that IP out for 15 minutes. The limiter is
  in-process in the worker (a long-running Fastify instance on Render, not a
  serverless function), which is what makes IP-based lockout actually durable
  across requests here.
- `POST /telegram/webhook` — Telegram as a second interactive chat surface.
  Verified via the `X-Telegram-Bot-Api-Secret-Token` header (must match
  `TELEGRAM_WEBHOOK_SECRET`), authorized by matching the incoming `chat.id`
  against `users.telegram_chat_id` (single allowlisted user — no arbitrary
  Telegram user can use the bot as a chat interface even if they find it).
  Same `AgentRuntime.chat()` call as the web chat, so it shares the same
  tools, audit trail, conversation history, and memory.
- **Conversation memory.** `conversation_messages` stores the last 20
  messages of a thread and replays them on every turn. Note that tool messages
  occupy that budget too, so one tool-heavy turn can push most of the actual
  dialogue out of the window. A window can also open mid tool-call sequence,
  leaving a `tool` message whose `tool_calls` assistant fell outside it — the
  API rejects that outright, so such orphans are trimmed before the request is
  built. See the per-thread, per-channel model below for how threads are
  scoped.
- **Semantic memory.** After each turn, a second cheap LLM call extracts
  durable facts/preferences worth remembering (ignoring transient chatter)
  into `memories`, keyed by `(userId, key)` so restating a fact updates the
  existing row instead of creating a duplicate — the extractor is shown the
  user's existing keys specifically to make this dedup work. The top facts
  by importance are injected into the system prompt on every turn.
- **Tool permission layer, with confirmation kept out of the model's hands.**
  `apps/worker/src/agent/permissions.ts` maps every tool to an `auto` or
  `confirm` policy (unlisted tools default to `confirm`). Reads and low-risk
  task/reminder writes are `auto`; `createSubtasks` is the first real
  `confirm` tool, since one breakdown can add up to 20 rows to the user's
  actual Notion database. A `confirm`-policy
  tool call is intercepted before execution and recorded in
  `approval_requests` instead of running; `ChatResult.pendingApproval` tells
  the channel to show a real confirm UI. There is no LLM-callable
  "confirmAction" tool — the model can only propose and narrate, never
  resolve its own pending approval. The only things that move an approval
  from pending are a Telegram inline-button callback or `POST
  /approvals/:id/decision` (web), both driven by an actual user click.

- **Notion, as a read-only knowledge tool.** When `NOTION_API_KEY` is set, the
  agent gains `notion_search`/`notion_get_page` tools (both `auto` policy —
  read-only) to look up pages in the user's Notion workspace as context.
  Unset the env var to disable the integration entirely.
- **Notion as the task-editing surface, Postgres as the source of truth for
  scheduling.** When `NOTION_TASKS_DATABASE_ID` is also set, tasks are
  two-way synced with that database (`apps/worker/src/services/notion-sync.ts`):
  the scheduler tick pulls in edits made on the Notion side (title, status,
  priority, due date, description) and re-derives reminders for them exactly
  like any other task write; every `createTask`/`updateTask`/`completeTask`
  pushes the result back to its Notion page, creating it on first sync.
  Postgres — not Notion — stays canonical for anything transactional
  (reminder derivation, the outbox, idempotent delivery); Notion is a
  best-effort mirror so the day-to-day editing surface can be Notion's UI
  instead of this app's. See the property-schema requirements in
  `.env.example`.
- **A morning briefing, as the one thing that starts a conversation.** Every
  tick checks whether each user is due their daily briefing in *their* timezone
  and sends it over Telegram: what's overdue, what's due today, and the next
  step of anything broken down. The model writes it and opens with what to do
  first, but the plain rendering of the same data is the fallback, so a failed
  composition costs wording rather than the whole briefing. A quiet day sends
  nothing at all — a daily "nothing due" trains the reader to ignore the
  channel, which costs more than it gives on the days something is wrong.
  Deliberately *not* on the reminder/outbox pipeline: that path is task-scoped
  end to end (`reminders.taskId`, `trigger_runs.reminderId` and the chat-id
  resolver all require a task), and a briefing belongs to no task, so riding it
  would mean loosening three constraints in the most reliability-critical code
  here. Instead `users.last_briefing_on` stores the *local calendar date* of
  the last send: that makes "already sent today?" a question about the user's
  day with no timezone arithmetic, and writing it only after a successful send
  means a failure just retries next tick. A missed target time is caught up
  within 4 hours and then abandoned, so a host that was asleep at 07:00 doesn't
  deliver "here's your morning" at dinner.
- **Conversations are per-thread and per-channel.** A `conversations` row is a
  chat thread in the ChatGPT sense: the web app opens one per "New chat",
  Telegram opens one per `/new` (it has no button to click). `channel` keeps the
  two surfaces apart, because "continue where I left off" has to mean the latest
  *web* thread on the web and the latest *Telegram* thread on Telegram —
  without that scoping, a Telegram message lands in whatever thread the browser
  used last, which is exactly how the two used to share one endless thread.
  Threads from both channels are listed together in the web sidebar, labelled.
  An explicit `conversationId` is only honoured if it belongs to the caller;
  otherwise a fresh thread is started rather than trusting a client-supplied id.
  Omitting the id means "continue", so "New chat" sends an explicit
  `startNewConversation` — and since both entry points create the row before
  there's anything in it, the thread list hides threads with no messages.
  Titles come from a one-off LLM call after the first exchange (once per
  thread, not per message); a thread whose titling failed simply shows a
  placeholder.
- **Task progress, counted rather than typed in.** A task can have subtasks
  (steps) — real task rows with a `parentTaskId`, mirrored to Notion's `Parent`
  self-relation. Progress is always *derived* (`done/total` over the steps) and
  never stored as a number the user maintains, so it can't drift from reality;
  cancelled steps leave both sides of the ratio, so abandoning a step doesn't
  leave the task looking permanently unfinished. A task with no steps reports
  `progress: null` — deliberately distinct from 0%, since "not broken down" is
  not "nothing done". Steps never appear as their own entries in the Now view
  or task list: a task split into six steps stays one line, carrying its count
  and its next unfinished step. Steps inherit the parent's type/priority but
  get no due date, so one deadline doesn't multiply into six reminders.
  Notion's rollups can't count children by select value, so the app writes a
  derived `Progress` percent onto the parent page; `notion_progress_pushed`
  guards that write, since every push bumps `last_edited_time` and would
  otherwise pull the page into the next sync pass forever.
- **Breaking a task down, as two tools rather than one.** `proposeTaskBreakdown`
  (`auto`, writes nothing) asks the LLM for steps — using `LLM_BREAKDOWN_MODEL`
  and a focused prompt, plus the task's Notion page body as context, because
  decomposition is a harder reasoning job than the chat turn requesting it.
  `createSubtasks` (`confirm`) then creates the exact titles the user was shown.
  The split is required, not stylistic: a `confirm` tool is intercepted *before*
  it executes, so a single `breakdownTask` tool would ask the user to approve
  without any steps to look at — and re-generating them at approval time could
  create steps they never agreed to.
- **Web search.** When `TAVILY_API_KEY` is set, the agent gains a `web_search`
  tool (`auto` policy) for current-events/internet lookups beyond training
  data. The system prompt also injects the current UTC date/time every turn
  so the model can resolve relative dates ("tomorrow", "next Monday")
  against a real clock instead of guessing.

## Deliberately deferred

- **A native Anthropic (Messages API) adapter.** The current adapter only
  covers OpenAI-compatible wire formats. Anthropic's API shape differs enough
  that it needs its own `AgentRuntime` implementation, not a config flag on
  `OpenAICompatibleAgentAdapter`.
- **Vercel project** for `apps/web` — not deployed yet; everything else
  (Supabase Postgres, Render worker, Telegram webhook, EventBridge Scheduler +
  Lambda + SQS DLQ) is live.
- Deeper observability (structured `request_id`/`agent_run_id`/`trigger_run_id`
  correlation across logs, alerting on DLQ/outbox-failed) beyond the
  `agent_runs` audit table and Fastify's default request logging.
- Calendar/Gmail integrations — explicitly phase 2 per the plan.
