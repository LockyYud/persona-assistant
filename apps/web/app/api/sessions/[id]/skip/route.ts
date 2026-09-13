import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCurrentUserId, skipSession } from "@/lib/worker-client";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  return NextResponse.json(await skipSession(await getCurrentUserId(session.user.email), id));
}
