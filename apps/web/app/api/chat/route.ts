import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, sendChatMessage } from "@/lib/worker-client";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { message, conversationId } = (await request.json()) as {
    message: string;
    conversationId?: string;
  };

  const userId = await getCurrentUserId(session.user.email);
  const result = await sendChatMessage(userId, message, conversationId);
  return NextResponse.json(result);
}
