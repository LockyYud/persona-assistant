import { loadRootEnv } from "@persona/db";

/**
 * Verifies that the Notion side is actually wired up: the integration can see
 * each database, and each database has the properties the sync writes to.
 *
 * Worth a script rather than a paragraph of instructions because all three
 * failure modes look identical from the app — a database not shared with the
 * integration, a wrong id, and a mistyped property name all just mean "nothing
 * appears in Notion", with the error swallowed by the best-effort push.
 */
const REQUIRED: Record<string, { name: string; type: string; optional?: boolean }[]> = {
  NOTION_TASKS_DATABASE_ID: [
    { name: "Title", type: "title" },
    { name: "Status", type: "select" },
    { name: "Priority", type: "select" },
    { name: "Type", type: "select" },
    { name: "Description", type: "rich_text" },
    { name: "Due", type: "date" },
    { name: "Parent", type: "relation" },
    { name: "Progress", type: "number" },
    { name: "Monthly Target (h)", type: "number", optional: true },
  ],
  NOTION_SESSIONS_DATABASE_ID: [
    { name: "Title", type: "title" },
    { name: "Task", type: "relation" },
    { name: "Date", type: "date" },
    { name: "Planned", type: "number" },
    { name: "Actual", type: "number" },
    { name: "Status", type: "select" },
  ],
};

async function checkDatabase(apiKey: string, envVar: string): Promise<boolean> {
  const databaseId = process.env[envVar];
  if (!databaseId) {
    console.log(`\n${envVar}: not set — skipping (that integration is simply off).`);
    return true;
  }

  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1/databases/${databaseId.replace(/-/g, "")}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "notion-version": "2022-06-28",
      },
    });
  } catch (error) {
    // Attributed to the database being checked: a bare "fetch failed" gives no
    // clue which of them, or that the problem is the network rather than Notion.
    console.log(
      `\n${envVar}: ✗ could not reach api.notion.com — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  const body = (await response.json()) as {
    title?: Array<{ plain_text: string }>;
    properties?: Record<string, { type: string }>;
    message?: string;
    code?: string;
  };

  if (!response.ok) {
    console.log(`\n${envVar}: ✗ ${body.code ?? response.status} — ${body.message}`);
    if (body.code === "object_not_found") {
      console.log(
        "  Either the id is wrong, or the database has not been shared with the " +
          "integration. Notion returns the same error for both on purpose, so that " +
          "an integration cannot probe for pages it has no access to.",
      );
    }
    return false;
  }

  const title = (body.title ?? []).map((t) => t.plain_text).join("") || "(untitled)";
  console.log(`\n${envVar}: ✓ reachable — "${title}"`);

  const properties = body.properties ?? {};
  let ok = true;

  for (const expected of REQUIRED[envVar] ?? []) {
    const actual = properties[expected.name];
    if (!actual) {
      const label = expected.optional ? "optional, missing" : "MISSING";
      console.log(`  ${expected.optional ? "-" : "✗"} ${expected.name} (${label})`);
      if (!expected.optional) ok = false;
      continue;
    }
    if (actual.type !== expected.type) {
      console.log(`  ✗ ${expected.name} is "${actual.type}", must be "${expected.type}"`);
      ok = false;
      continue;
    }
    console.log(`  ✓ ${expected.name}`);
  }

  const extra = Object.keys(properties).filter(
    (name) => !(REQUIRED[envVar] ?? []).some((e) => e.name === name),
  );
  if (extra.length > 0) console.log(`  (ignored by the app: ${extra.join(", ")})`);

  return ok;
}

async function main() {
  loadRootEnv();
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error("NOTION_API_KEY is not set — the Notion integration is off entirely.");
  }

  const results = await Promise.all(
    Object.keys(REQUIRED).map((envVar) => checkDatabase(apiKey, envVar)),
  );

  if (results.every(Boolean)) {
    console.log("\nAll set.");
    return;
  }
  console.log("\nSomething above needs fixing before the sync will work.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
