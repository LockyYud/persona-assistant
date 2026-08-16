import { schema, createDb } from "@persona/db";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const email = process.env.AUTH_ALLOWED_EMAIL;
  if (!databaseUrl || !email) {
    throw new Error("DATABASE_URL and AUTH_ALLOWED_EMAIL are required");
  }

  const db = createDb(databaseUrl);

  await db
    .insert(schema.users)
    .values({ email, timezone: "Asia/Bangkok" })
    .onConflictDoNothing({ target: schema.users.email });

  console.log(`Seeded user ${email}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
