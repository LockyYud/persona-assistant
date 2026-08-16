import { and, eq, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { NotificationChannel } from "@persona/integrations";
import { computeNextOccurrence } from "./rrule.js";

const LEASE_DURATION_MS = 2 * 60 * 1000;
const MAX_OUTBOX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30 * 1000;

export interface TickResult {
  recovered: number;
  claimedReminders: number;
  dispatched: number;
  failed: number;
}

function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
}

async function recoverExpiredLeases(db: Database): Promise<number> {
  const now = new Date();

  const recoveredTriggerRuns = await db
    .update(schema.triggerRuns)
    .set({ status: "pending", leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(schema.triggerRuns.status, "processing"),
        lte(schema.triggerRuns.leaseExpiresAt, now),
      ),
    )
    .returning({ id: schema.triggerRuns.id });

  const recoveredOutbox = await db
    .update(schema.outbox)
    .set({ status: "pending", leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(schema.outbox.status, "processing"), lte(schema.outbox.leaseExpiresAt, now)))
    .returning({ id: schema.outbox.id });

  return recoveredTriggerRuns.length + recoveredOutbox.length;
}

async function claimDueReminders(db: Database): Promise<number> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const due = await tx.execute(sql`
      SELECT * FROM ${schema.reminders}
      WHERE ${schema.reminders.status} = 'active'
        AND ${schema.reminders.nextRunAt} <= ${now}
      FOR UPDATE SKIP LOCKED
    `);

    const rows = due.rows as unknown as (typeof schema.reminders.$inferSelect)[];
    let claimed = 0;

    for (const reminder of rows) {
      const scheduledFor = reminder.nextRunAt;
      const idempotencyKey = `${reminder.id}:${scheduledFor.toISOString()}`;

      const [triggerRun] = await tx
        .insert(schema.triggerRuns)
        .values({
          reminderId: reminder.id,
          idempotencyKey,
          scheduledFor,
          status: "pending",
        })
        .onConflictDoNothing({ target: schema.triggerRuns.idempotencyKey })
        .returning();

      if (triggerRun) {
        await tx.insert(schema.outbox).values({
          triggerRunId: triggerRun.id,
          channel: "telegram",
          payload: { reminderId: reminder.id, message: reminder.message },
          status: "pending",
        });
        claimed += 1;
      }

      if (reminder.rrule) {
        const next = computeNextOccurrence(reminder.rrule, scheduledFor);
        if (next) {
          await tx
            .update(schema.reminders)
            .set({ nextRunAt: next, updatedAt: new Date() })
            .where(eq(schema.reminders.id, reminder.id));
        } else {
          await tx
            .update(schema.reminders)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(schema.reminders.id, reminder.id));
        }
      } else {
        await tx
          .update(schema.reminders)
          .set({ status: "completed", updatedAt: new Date() })
          .where(eq(schema.reminders.id, reminder.id));
      }
    }

    return claimed;
  });
}

async function dispatchOutbox(
  db: Database,
  channel: NotificationChannel,
  getChatId: (triggerRunId: string) => Promise<string | null>,
): Promise<{ dispatched: number; failed: number }> {
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_DURATION_MS);

  const claimedRows = await db.transaction(async (tx) => {
    const pending = await tx.execute(sql`
      SELECT * FROM ${schema.outbox}
      WHERE ${schema.outbox.status} = 'pending'
        AND ${schema.outbox.availableAt} <= ${now}
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `);

    const rows = pending.rows as unknown as (typeof schema.outbox.$inferSelect)[];
    if (rows.length === 0) return [];

    await tx
      .update(schema.outbox)
      .set({ status: "processing", leaseExpiresAt: lease, updatedAt: now })
      .where(
        or(
          ...rows.map((row) => eq(schema.outbox.id, row.id)),
        ),
      );

    return rows;
  });

  let dispatched = 0;
  let failed = 0;

  for (const record of claimedRows) {
    try {
      if (!record.triggerRunId) {
        throw new Error("Outbox record missing triggerRunId");
      }

      const chatId = await getChatId(record.triggerRunId);
      if (!chatId) {
        throw new Error("No Telegram chat linked for user");
      }

      const payload = record.payload as { message: string };
      const result = await channel.send({ chatId, text: payload.message });

      await db.transaction(async (tx) => {
        await tx
          .update(schema.outbox)
          .set({ status: "sent", updatedAt: new Date() })
          .where(eq(schema.outbox.id, record.id));

        await tx.insert(schema.notificationDeliveries).values({
          triggerRunId: record.triggerRunId as string,
          channel: "telegram",
          providerMessageId: result.providerMessageId,
          status: "sent",
        });

        await tx
          .update(schema.triggerRuns)
          .set({ status: "completed", updatedAt: new Date() })
          .where(eq(schema.triggerRuns.id, record.triggerRunId as string));
      });

      dispatched += 1;
    } catch (error) {
      const attempts = record.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attempts >= MAX_OUTBOX_ATTEMPTS;

      await db.transaction(async (tx) => {
        await tx
          .update(schema.outbox)
          .set({
            status: exhausted ? "failed" : "pending",
            attempts,
            availableAt: new Date(Date.now() + backoffMs(attempts)),
            leaseExpiresAt: null,
            lastError: message,
            updatedAt: new Date(),
          })
          .where(eq(schema.outbox.id, record.id));

        if (exhausted && record.triggerRunId) {
          await tx.insert(schema.notificationDeliveries).values({
            triggerRunId: record.triggerRunId,
            channel: "telegram",
            status: "failed",
            error: message,
          });

          await tx
            .update(schema.triggerRuns)
            .set({ status: "failed", lastError: message, updatedAt: new Date() })
            .where(eq(schema.triggerRuns.id, record.triggerRunId));
        }
      });

      failed += 1;
    }
  }

  return { dispatched, failed };
}

export async function runTick(
  db: Database,
  channel: NotificationChannel,
  getChatId: (triggerRunId: string) => Promise<string | null>,
): Promise<TickResult> {
  const recovered = await recoverExpiredLeases(db);
  const claimedReminders = await claimDueReminders(db);
  const { dispatched, failed } = await dispatchOutbox(db, channel, getChatId);

  return { recovered, claimedReminders, dispatched, failed };
}
