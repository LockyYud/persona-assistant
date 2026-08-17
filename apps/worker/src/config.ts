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
  tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
  llm: {
    apiKey: required("LLM_API_KEY"),
    baseURL: process.env.LLM_BASE_URL || undefined,
    model: required("LLM_MODEL"),
  },
};
