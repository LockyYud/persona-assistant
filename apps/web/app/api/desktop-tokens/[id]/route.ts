import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, revokeDesktopToken } from "@/lib/worker-client";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = await getCurrentUserId(session.user.email);
  const result = await revokeDesktopToken(userId, id);
  return NextResponse.json(result);
}
