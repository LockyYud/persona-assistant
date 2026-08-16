import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@persona/db";

export async function createApprovalRequest(
  db: Database,
  params: { userId: string; agentRunId: string | null; action: string; payload: unknown },
): Promise<typeof schema.approvalRequests.$inferSelect> {
  const [row] = await db
    .insert(schema.approvalRequests)
    .values({
      userId: params.userId,
      agentRunId: params.agentRunId,
      action: params.action,
      payload: params.payload as Record<string, unknown>,
      status: "pending",
    })
    .returning();

  if (!row) throw new Error("Failed to create approval request");
  return row;
}

export async function resolveApproval(
  db: Database,
  approvalId: string,
  userId: string,
  decision: "approved" | "rejected",
): Promise<typeof schema.approvalRequests.$inferSelect | null> {
  const [row] = await db
    .update(schema.approvalRequests)
    .set({ status: decision, approvedAt: decision === "approved" ? new Date() : null })
    .where(
      and(
        eq(schema.approvalRequests.id, approvalId),
        eq(schema.approvalRequests.userId, userId),
        eq(schema.approvalRequests.status, "pending"),
      ),
    )
    .returning();

  return row ?? null;
}
