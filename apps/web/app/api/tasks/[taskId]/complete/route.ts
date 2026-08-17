import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { completeTask, getCurrentUserId } from "@/lib/worker-client";

export async function POST(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { taskId } = await params;
  const userId = await getCurrentUserId(session.user.email);
  const result = await completeTask(userId, taskId);
  return NextResponse.json(result);
}
