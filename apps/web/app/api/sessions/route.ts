import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, planSession } from "@/lib/worker-client";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const input = (await request.json()) as { sessionId?: string; taskId?: string; plannedMinutes?: number; focusText?: string | null; startAt?: string | null };
  const plannedMinutes = input.plannedMinutes;
  if (!input.taskId || typeof plannedMinutes !== "number" || !Number.isInteger(plannedMinutes) || plannedMinutes < 1) {
    return NextResponse.json({ error: "invalid session" }, { status: 400 });
  }
  const planned = await planSession(await getCurrentUserId(session.user.email), {
    sessionId: input.sessionId,
    taskId: input.taskId,
    plannedMinutes,
    focusText: input.focusText,
    startAt: input.startAt,
  });
  return NextResponse.json(planned);
}
