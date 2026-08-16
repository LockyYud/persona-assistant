import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { decideApproval, getCurrentUserId } from "@/lib/worker-client";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { approvalId, decision } = (await request.json()) as {
    approvalId: string;
    decision: "approved" | "rejected";
  };

  const userId = await getCurrentUserId(session.user.email);
  const result = await decideApproval(userId, approvalId, decision);
  return NextResponse.json(result);
}
