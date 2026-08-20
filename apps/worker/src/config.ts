function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  internalHmacSecret: required("WORKER_INTERNAL_HMAC_SECRET"),
  bffSharedSecret: required("WORKER_BFF_SHARED_SECRET"),
  authPasswordHash: required("AUTH_PASSWORD_HASH"),
  authAllowedEmail: required("AUTH_ALLOWED_EMAIL"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  notionApiKey: process.env.NOTION_API_KEY || undefined,
  // Notion database that mirrors the task list (see notion-sync.ts). Only
  // meaningful together with NOTION_API_KEY; unset to keep Notion read-only
  // (search/get_page tools) without the task sync.
  notionTasksDatabaseId: process.env.NOTION_TASKS_DATABASE_ID || undefined,
  tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
  llm: {
    apiKey: required("LLM_API_KEY"),
    baseURL: process.env.LLM_BASE_URL || undefined,
    model: required("LLM_MODEL"),
    // Splitting a task into steps is a harder reasoning job than a normal
    // chat turn, so it can run on a stronger model than the conversation
    // does (see services/task-breakdown.ts). Falls back to the chat model.
    breakdownModel: process.env.LLM_BREAKDOWN_MODEL || required("LLM_MODEL"),
  },
};
