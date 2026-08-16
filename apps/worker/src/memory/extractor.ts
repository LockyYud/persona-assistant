import type OpenAI from "openai";
import type { MemoryCandidate } from "./repository.js";

const EXTRACTOR_PROMPT = `Extract any durable facts or preferences about the user from this
exchange that are worth remembering long-term (tools/technologies they use, stated
preferences, recurring context about their projects or habits). Ignore anything transient
(mood, one-off requests, small talk).

You will be given the keys of facts already remembered about this user. If this exchange
restates or updates one of those facts, reuse its exact existing key so the record gets
updated instead of duplicated. Only invent a new key for a genuinely new fact.

Respond with JSON only, matching this shape:
{"memories":[{"type":"preference"|"fact"|"episodic","key":"short_snake_case_key","content":"one sentence","importance":0-100,"confidence":0-100}]}

If nothing durable was said, respond with {"memories":[]}.`;

/**
 * A second, cheap LLM call that decides what from this turn is worth
 * remembering. Kept separate from the main agent loop so the "should this be
 * durable?" judgment doesn't compete with tool-calling in the same prompt.
 */
export async function extractMemoryCandidates(
  client: OpenAI,
  model: string,
  userMessage: string,
  assistantReply: string,
  existingKeys: string[] = [],
): Promise<MemoryCandidate[]> {
  try {
    const keysNote =
      existingKeys.length > 0
        ? `Existing keys already remembered for this user: ${existingKeys.join(", ")}`
        : "No facts are remembered for this user yet.";

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACTOR_PROMPT },
        { role: "user", content: `${keysNote}\n\nUser: ${userMessage}\nAssistant: ${assistantReply}` },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return [];

    const parsed = JSON.parse(raw) as { memories?: unknown };
    if (!Array.isArray(parsed.memories)) return [];

    return parsed.memories.filter(isMemoryCandidate);
  } catch {
    // Memory extraction is best-effort; a failure here must never break the
    // user-facing chat response.
    return [];
  }
}

function isMemoryCandidate(value: unknown): value is MemoryCandidate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "preference" || v.type === "fact" || v.type === "episodic") &&
    typeof v.key === "string" &&
    v.key.length > 0 &&
    typeof v.content === "string" &&
    v.content.length > 0 &&
    typeof v.importance === "number" &&
    typeof v.confidence === "number"
  );
}
