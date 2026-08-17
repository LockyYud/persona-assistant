import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@persona/db";
import type { DesktopToken } from "@persona/core";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toDomainToken(row: typeof schema.desktopTokens.$inferSelect): DesktopToken {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Mints a new desktop token. The raw value is returned once and never
 * stored — only its sha256 hash is persisted, so a leaked DB row can't be
 * turned back into a usable credential.
 */
export async function mintDesktopToken(
  db: Database,
  userId: string,
  label: string,
): Promise<{ token: DesktopToken; raw: string }> {
  const raw = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(schema.desktopTokens)
    .values({ userId, label, tokenHash: hashToken(raw) })
    .returning();

  if (!row) throw new Error("Failed to create desktop token");
  return { token: toDomainToken(row), raw };
}

export async function listDesktopTokens(db: Database, userId: string): Promise<DesktopToken[]> {
  const rows = await db
    .select()
    .from(schema.desktopTokens)
    .where(eq(schema.desktopTokens.userId, userId));

  return rows.map(toDomainToken);
}

export async function revokeDesktopToken(
  db: Database,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const [row] = await db
    .update(schema.desktopTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.desktopTokens.id, tokenId), eq(schema.desktopTokens.userId, userId)))
    .returning();

  return !!row;
}

/**
 * Resolves a raw bearer value to its owning userId — never the other way
 * around. Callers must not accept a client-supplied userId alongside this;
 * the token IS the identity.
 */
export async function verifyDesktopToken(db: Database, raw: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.desktopTokens)
    .where(and(eq(schema.desktopTokens.tokenHash, hashToken(raw)), isNull(schema.desktopTokens.revokedAt)));

  if (!row) return null;

  await db
    .update(schema.desktopTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.desktopTokens.id, row.id));

  return row.userId;
}
