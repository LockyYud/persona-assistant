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

/** Claims one pending request. A second callback cannot execute the action. */
export async function claimApproval(
  db: Database,
  approvalId: string,
  userId: string,
): Promise<typeof schema.approvalRequests.$inferSelect | null> {
  const [row] = await db
    .update(schema.approvalRequests)
    .set({ status: "executing" })
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

export async function rejectApproval(db: Database, approvalId: string, userId: string) {
  const [row] = await db
    .update(schema.approvalRequests)
    .set({ status: "rejected" })
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

export async function finishApproval(
  db: Database,
  approvalId: string,
  status: "approved" | "failed",
) {
  const [row] = await db
    .update(schema.approvalRequests)
    .set({ status, approvedAt: status === "approved" ? new Date() : null })
    .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.status, "executing")))
    .returning();
  return row ?? null;
}
