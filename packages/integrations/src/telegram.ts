export interface TelegramMessage {
  chatId: string;
  text: string;
}

export interface NotificationChannel {
  send(message: TelegramMessage): Promise<{ providerMessageId: string }>;
}

export class TelegramNotificationChannel implements NotificationChannel {
  private readonly apiBase: string;

  constructor(private readonly botToken: string) {
    this.apiBase = `https://api.telegram.org/bot${botToken}`;
  }

  async send(message: TelegramMessage): Promise<{ providerMessageId: string }> {
    const response = await fetch(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: message.chatId,
        text: message.text,
        parse_mode: "HTML",
      }),
    });

    const body = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id: number };
    };

    if (!response.ok || !body.ok || !body.result) {
      throw new Error(`Telegram sendMessage failed: ${body.description ?? response.statusText}`);
    }

    return { providerMessageId: String(body.result.message_id) };
  }

  /**
   * One-time onboarding poll: find the chat_id whose /start payload matches
   * onboardingToken so the user can link their account without a public webhook.
   */
  async findChatIdByOnboardingToken(onboardingToken: string): Promise<string | null> {
    const response = await fetch(`${this.apiBase}/getUpdates?limit=100`);
    const body = (await response.json()) as {
      ok: boolean;
      result?: { message?: { chat: { id: number }; text?: string } }[];
    };

    if (!body.ok || !body.result) return null;

    for (const update of body.result) {
      const text = update.message?.text ?? "";
      if (text === `/start ${onboardingToken}`) {
        return String(update.message?.chat.id);
      }
    }

    return null;
  }
}
