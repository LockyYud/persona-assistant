import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, loadConversationMessages } from "@/lib/worker-client";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = await getCurrentUserId(session.user.email);

  try {
    return NextResponse.json(await loadConversationMessages(userId, id));
  } catch {
    // The worker 404s a thread that isn't this user's, which surfaces here as
    // a failed fetch — don't leak whether the id exists.
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
}
