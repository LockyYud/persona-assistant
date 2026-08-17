import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, schema, type Database } from "@persona/db";

// Point at a real, throwaway local Postgres — never the production DB.
// Spin one up and migrate it before running `pnpm test`:
//   docker run -d --name persona-test-db -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=persona_test -p 15432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:test@localhost:15432/persona_test \
//     pnpm --filter @persona/db migrate
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@localhost:15432/persona_test";

let db: Database | undefined;

/** A real Postgres connection (see docker command in README/test comments) — never the production DB. */
export function getTestDb(): Database {
  db ??= createDb(TEST_DATABASE_URL);
  return db;
}

/** Wipes every table (cascading from users) so each test starts from empty. */
export async function resetTestDb(): Promise<void> {
  await getTestDb().execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
}

export async function createTestUser(timezone = "Asia/Bangkok"): Promise<string> {
  const [user] = await getTestDb()
    .insert(schema.users)
    .values({ email: `test-${randomUUID()}@example.com`, timezone })
    .returning();
  if (!user) throw new Error("Failed to create test user");
  return user.id;
}
