import type OpenAI from "openai";

const TITLE_PROMPT = `Give this conversation a short title, the way a chat app labels a thread in
a sidebar.

Rules:
- 2 to 6 words. Never a whole sentence.
- Name the specific subject, not the activity: "Notion sync bug", not "User asks for help".
- Write it in the SAME LANGUAGE the user wrote in.
- No quotes, no trailing punctuation, no "Chat about ..." prefix.

Reply with JSON only: {"title":"..."}`;

const TITLE_MAX_LENGTH = 60;

/**
 * Names a thread from its opening exchange — one extra call per conversation,
 * not per message, since a title is only ever generated once.
 *
 * Returns null on any failure. A thread with no title still works: the client
 * falls back to showing its opening message, so this must never be allowed to
 * break or delay the reply the user is waiting for.
 */
export async function generateConversationTitle(
  client: OpenAI,
  model: string,
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: TITLE_PROMPT },
        { role: "user", content: `User: ${userMessage}\nAssistant: ${assistantReply}` },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content;
    return raw ? parseTitle(raw) : null;
  } catch {
    return null;
  }
}

/** Pulls a usable title out of the model's reply, or null if there isn't one. */
export function parseTitle(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const title = (parsed as { title?: unknown })?.title;
  if (typeof title !== "string") return null;

  // Models like to wrap titles in quotes and add a period despite being told
  // not to; strip both rather than storing them.
  const cleaned = title
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, TITLE_MAX_LENGTH) : null;
}
