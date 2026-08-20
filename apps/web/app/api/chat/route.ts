import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, sendChatMessage } from "@/lib/worker-client";

/**
 * A turn runs an agent loop of up to 5 model calls, and the worker's free
 * instance can add a cold start on top. The platform default (10s) cut the
 * connection while the turn kept running to completion server-side, so the
 * browser saw a failure for a message that had actually succeeded.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { message, conversationId, startNewConversation } = (await request.json()) as {
    message: string;
    conversationId?: string;
    startNewConversation?: boolean;
  };

  const userId = await getCurrentUserId(session.user.email);
  const result = await sendChatMessage(userId, message, conversationId, startNewConversation);
  return NextResponse.json(result);
}
