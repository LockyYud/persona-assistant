import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createTask, getCurrentUserId, listTasks } from "@/lib/worker-client";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userId = await getCurrentUserId(session.user.email);
  const result = await listTasks(userId);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const userId = await getCurrentUserId(session.user.email);
  const result = await createTask(userId, body);
  return NextResponse.json(result);
}
