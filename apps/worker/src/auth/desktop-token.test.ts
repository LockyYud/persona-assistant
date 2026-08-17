import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, getTestDb, resetTestDb } from "../test-support/db.js";
import {
  listDesktopTokens,
  mintDesktopToken,
  revokeDesktopToken,
  verifyDesktopToken,
} from "./desktop-token.js";

describe("desktop tokens", () => {
  beforeEach(resetTestDb);

  it("mints a token whose raw value resolves back to the owning user", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const { raw } = await mintDesktopToken(db, userId, "This laptop");
    const resolved = await verifyDesktopToken(db, raw);

    expect(resolved).toBe(userId);
  });

  it("rejects a garbage or unknown token", async () => {
    const db = getTestDb();
    expect(await verifyDesktopToken(db, "not-a-real-token")).toBeNull();
  });

  it("never resolves a revoked token, even with the correct raw value", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const { token, raw } = await mintDesktopToken(db, userId, "Old laptop");
    const revoked = await revokeDesktopToken(db, userId, token.id);

    expect(revoked).toBe(true);
    expect(await verifyDesktopToken(db, raw)).toBeNull();
  });

  it("revoke is scoped to the owning user — another user's id can't revoke it", async () => {
    const ownerId = await createTestUser();
    const otherUserId = await createTestUser();
    const db = getTestDb();

    const { token, raw } = await mintDesktopToken(db, ownerId, "Owner's laptop");
    const revokedByOther = await revokeDesktopToken(db, otherUserId, token.id);

    expect(revokedByOther).toBe(false);
    expect(await verifyDesktopToken(db, raw)).toBe(ownerId);
  });

  it("records lastUsedAt after a successful verify", async () => {
    const userId = await createTestUser();
    const db = getTestDb();

    const { token, raw } = await mintDesktopToken(db, userId, "This laptop");
    expect(token.lastUsedAt).toBeNull();

    await verifyDesktopToken(db, raw);

    const [after] = await listDesktopTokens(db, userId);
    expect(after?.lastUsedAt).not.toBeNull();
  });
});
