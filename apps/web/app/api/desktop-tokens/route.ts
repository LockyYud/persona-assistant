import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, listDesktopTokens, mintDesktopToken } from "@/lib/worker-client";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userId = await getCurrentUserId(session.user.email);
  const result = await listDesktopTokens(userId);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Desktop";

  const userId = await getCurrentUserId(session.user.email);
  const result = await mintDesktopToken(userId, label);
  return NextResponse.json(result);
}
