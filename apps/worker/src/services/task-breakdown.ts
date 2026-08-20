import OpenAI from "openai";
import type { Task } from "@persona/core";

/**
 * Breaking a task into the right steps is a reasoning job, and a noticeably
 * harder one than the chat turn that asks for it — so it gets its own call
 * with its own (usually stronger) model rather than riding on whatever the
 * conversation is using. See LLM_BREAKDOWN_MODEL in config.ts.
 */
const SYSTEM_PROMPT = `You break a task down into the concrete steps needed to finish it.

Rules:
- Return 2-8 steps. Fewer is better than padding; if a task genuinely needs
  only two steps, return two.
- Each step must be a specific, checkable action — something the user can look
  at and say "done" or "not done". "Research options" is bad; "Compare pricing
  of Supabase vs Neon" is good.
- Steps must be in the order they should be done.
- Do NOT invent scope the task doesn't imply, and do not add generic filler
  steps like "plan", "review", or "test" unless the task actually calls for them.
- Write each step in the SAME LANGUAGE as the task title.
- Keep each step under 100 characters.

Reply with JSON only: {"steps": ["...", "..."]}`;

const MAX_STEPS = 8;
const STEP_TITLE_MAX = 200;

export interface BreakdownResult {
  steps: string[];
}

export class TaskBreakdownService {
  private readonly client: OpenAI;

  constructor(
    provider: { apiKey: string; baseURL?: string },
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  }

  /**
   * Proposes steps for a task. Creates nothing — the caller shows these to the
   * user, and only an explicit confirmation turns them into subtasks.
   *
   * `extraContext` is whatever the user said to steer the split, plus (when
   * available) the task's Notion page body, since that's where the actual
   * detail of a task tends to live.
   */
  async propose(task: Task, extraContext?: string): Promise<BreakdownResult> {
    const details = [
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : null,
      `Category: ${task.type}`,
      task.dueAt ? `Due: ${task.dueAt.toISOString()}` : null,
      extraContext ? `Additional context:\n${extraContext}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: details },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    return { steps: parseSteps(raw) };
  }
}

/**
 * Pulls the step list out of the model's reply. Anything unparseable or
 * unusable yields an empty list rather than a throw — the caller reports "I
 * couldn't split this" and the user is no worse off than before.
 */
export function parseSteps(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const steps = (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return [];

  const cleaned: string[] = [];
  for (const step of steps) {
    if (typeof step !== "string") continue;
    const title = step.trim().slice(0, STEP_TITLE_MAX);
    // Drop blanks and exact repeats — a duplicated step would become two
    // separate subtasks that can never be told apart.
    if (title.length > 0 && !cleaned.includes(title)) cleaned.push(title);
    if (cleaned.length === MAX_STEPS) break;
  }

  return cleaned;
}
