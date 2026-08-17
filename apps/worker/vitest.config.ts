import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several test files share one real Postgres instance (see
    // test-support/db.ts) and each resets it in beforeEach — running test
    // files in parallel causes concurrent TRUNCATEs to deadlock and lets
    // one file's reset delete rows another file is mid-test with.
    fileParallelism: false,
  },
});
