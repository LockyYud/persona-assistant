# Persona Assistant

Single-user MVP: web chat (Next.js/Vercel), worker/agent (Fastify/Render),
Postgres (Supabase), Telegram as both an outbound notification channel and an
interactive chat channel. See the strategy doc in the repo root for the full
plan this implements (Telegram-as-chat is an extension beyond that plan's
original "delivery-only" scope).

## Layout

- `apps/web` — Next.js App Router, Auth.js Google OAuth (single allowlisted
  email), chat + tasks UI, BFF routes that call the worker with a shared secret.
- `apps/worker` — Fastify API: `/chat`, `/tasks`, `/tasks/:taskId`,
  `/internal/tick`, `/telegram/webhook`, `/health`, `/users/me`. Owns the LLM
  adapter, task/reminder services, and the outbox/scheduler tick logic.
- `apps/scheduler-lambda` — Lambda invoked every minute by EventBridge
  Scheduler; HMAC-signs an empty body and calls `/internal/tick`.
- `packages/core` — domain types, Zod schemas, `TaskService`/`ReminderService`/
  `AgentRuntime` interfaces.
- `packages/db` — Drizzle schema + migrations, via `pg` (works against
  Supabase, Neon, Render Postgres, or any standard Postgres host).
- `packages/integrations` — Telegram Bot API client + onboarding helper.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, secrets, Google/Telegram/LLM keys
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
- Google OAuth with single-email allowlist enforced in the `signIn` callback
  and route `middleware.ts`.
- `POST /telegram/webhook` — Telegram as a second interactive chat surface.
  Verified via the `X-Telegram-Bot-Api-Secret-Token` header (must match
  `TELEGRAM_WEBHOOK_SECRET`), authorized by matching the incoming `chat.id`
  against `users.telegram_chat_id` (single allowlisted user — no arbitrary
  Telegram user can use the bot as a chat interface even if they find it).
  Same `AgentRuntime.chat()` call as the web chat, so it shares the same
  tools, audit trail, conversation history, and memory.
- **Conversation memory.** `conversation_messages` stores the last 20
  messages per conversation and replays them on every turn — the web UI
  keeps its own `conversationId` across calls; Telegram has no such concept,
  so it reuses the user's most recently active conversation instead of
  starting fresh every message. Both channels therefore share one continuous
  thread unless the web client explicitly starts a new one.
- **Semantic memory.** After each turn, a second cheap LLM call extracts
  durable facts/preferences worth remembering (ignoring transient chatter)
  into `memories`, keyed by `(userId, key)` so restating a fact updates the
  existing row instead of creating a duplicate — the extractor is shown the
  user's existing keys specifically to make this dedup work. The top facts
  by importance are injected into the system prompt on every turn.
- **Tool permission layer.** `apps/worker/src/agent/permissions.ts` maps
  every tool to an `auto` or `confirm` policy (unlisted tools default to
  `confirm`). The 5 current tools are all `auto` (read/low-risk task and
  reminder actions). A `confirm`-policy tool call is intercepted before
  execution: it's recorded in `approval_requests` instead of running, and the
  model is told to ask the user; a `confirmAction`/`rejectAction` tool call
  on a later turn executes or discards it. No current tool needs this yet —
  it's infrastructure for when a destructive/external tool (delete, send
  email, Notion write) is added later.

## Deliberately deferred

- **A native Anthropic (Messages API) adapter.** The current adapter only
  covers OpenAI-compatible wire formats. Anthropic's API shape differs enough
  that it needs its own `AgentRuntime` implementation, not a config flag on
  `OpenAICompatibleAgentAdapter`.
- **Infra provisioning** (Render service, Vercel project, EventBridge
  Scheduler + Lambda + SQS DLQ, secret storage) — needs your cloud
  credentials; not something to script blind. Supabase Postgres is already
  provisioned (project `persona-assistant`, region `ap-southeast-1`),
  migrated, and seeded.
- Deeper observability (structured `request_id`/`agent_run_id`/`trigger_run_id`
  correlation across logs, alerting on DLQ/outbox-failed) beyond the
  `agent_runs` audit table and Fastify's default request logging.
- Notion/Calendar/Gmail integrations — explicitly phase 2 per the plan.
