/**
 * One-time onboarding: run this, then send `/start <TELEGRAM_ONBOARDING_TOKEN>`
 * to the bot from Duy's Telegram account. Links users.telegram_chat_id so the
 * scheduler can deliver reminders.
 *
 * Usage: tsx src/scripts/telegram-onboarding.ts <userEmail>
 */
import { eq } from "drizzle-orm";
import { schema, createDb } from "@persona/db";
import { TelegramNotificationChannel } from "@persona/integrations";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("Usage: telegram-onboarding.ts <userEmail>");

  const databaseUrl = process.env.DATABASE_URL;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const onboardingToken = process.env.TELEGRAM_ONBOARDING_TOKEN;
  if (!databaseUrl || !botToken || !onboardingToken) {
    throw new Error("DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_ONBOARDING_TOKEN are required");
  }

  const db = createDb(databaseUrl);
  const channel = new TelegramNotificationChannel(botToken);

  console.log(`Waiting for /start ${onboardingToken} from Telegram...`);

  const chatId = await pollUntilFound(() => channel.findChatIdByOnboardingToken(onboardingToken));

  await db.update(schema.users).set({ telegramChatId: chatId }).where(eq(schema.users.email, email));

  console.log(`Linked ${email} to Telegram chat ${chatId}`);
}

async function pollUntilFound(check: () => Promise<string | null>): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const chatId = await check();
    if (chatId) return chatId;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Timed out waiting for onboarding message");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
