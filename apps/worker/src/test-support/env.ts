// Imported for side effects, before any module that imports ./config.js —
// config.ts reads these eagerly at module-load time via required(), so they
// must exist before that import happens. Real values are never read from
// here; tests that need a real DB point TEST_DATABASE_URL at the local
// throwaway Postgres, never the production one.
process.env.DATABASE_URL ??= "postgres://postgres:test@localhost:15432/persona_test";
process.env.WORKER_INTERNAL_HMAC_SECRET ??= "test-hmac-secret";
process.env.WORKER_BFF_SHARED_SECRET ??= "test-bff-secret";
process.env.AUTH_PASSWORD_HASH ??= "$2a$10$test.hash.value.not.a.real.bcrypt.digest.aaaaaaaaaaaaaaaa";
process.env.AUTH_ALLOWED_EMAIL ??= "test@example.com";
process.env.LLM_API_KEY ??= "test-llm-key";
process.env.LLM_MODEL ??= "test-model";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "test-webhook-secret";
