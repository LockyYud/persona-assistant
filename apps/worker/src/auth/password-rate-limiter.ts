const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  windowStartedAt: number;
}

/**
 * In-memory per-key (IP) lockout. Deliberately in-process rather than in
 * Postgres: the worker is a single long-running Fastify instance on Render,
 * not a serverless function, so this state actually persists across
 * requests for as long as the process stays up — good enough for a
 * single-user app's login endpoint. Resets on deploy/restart, which is an
 * acceptable trade-off for the simplicity this buys.
 */
const attempts = new Map<string, AttemptRecord>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.windowStartedAt > WINDOW_MS) {
    return { allowed: true };
  }

  if (record.count >= MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((record.windowStartedAt + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.windowStartedAt > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStartedAt: now });
    return;
  }

  record.count += 1;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
