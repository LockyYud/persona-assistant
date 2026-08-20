import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, listConversations } from "@/lib/worker-client";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userId = await getCurrentUserId(session.user.email);
  return NextResponse.json(await listConversations(userId));
}
