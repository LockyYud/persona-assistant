import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the repo-root `.env` into `process.env`, for the scripts that are run
 * by hand — migrations and seeding.
 *
 * The deployed worker gets its environment from its host, so nothing in the
 * app has ever needed this; but `pnpm --filter @persona/db migrate` had no way
 * to see the `.env` the README tells you to create, and failed with "
 * DATABASE_URL is required" on a machine that plainly had one.
 *
 * The root is found by walking up for `pnpm-workspace.yaml` rather than by
 * counting directories, so it works from `src` or `dist` and regardless of
 * whether the script was launched from the repo root or from inside a package.
 * Variables already set win — Node's own env-file semantics — so an inline
 * `DATABASE_URL=... pnpm migrate` still points exactly where it was told,
 * which is how the throwaway test database is targeted.
 */
export function loadRootEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) process.loadEnvFile(envPath);
      return;
    }

    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
