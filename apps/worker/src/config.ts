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
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  deepseekModel: process.env.DEEPSEEK_HARNESS_MODEL ?? "deepseek-chat",
};
