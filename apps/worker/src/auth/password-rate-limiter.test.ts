import { describe, expect, it } from "vitest";
import { checkRateLimit, clearAttempts, recordFailedAttempt } from "./password-rate-limiter.js";

describe("password rate limiter", () => {
  it("allows attempts under the threshold", () => {
    const key = "test-key-under-threshold";
    for (let i = 0; i < 4; i += 1) {
      expect(checkRateLimit(key).allowed).toBe(true);
      recordFailedAttempt(key);
    }
  });

  it("locks out after 5 failed attempts and reports retryAfterSeconds", () => {
    const key = "test-key-lockout";
    for (let i = 0; i < 5; i += 1) {
      recordFailedAttempt(key);
    }

    const result = checkRateLimit(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("clearAttempts resets the lockout", () => {
    const key = "test-key-clear";
    for (let i = 0; i < 5; i += 1) {
      recordFailedAttempt(key);
    }
    expect(checkRateLimit(key).allowed).toBe(false);

    clearAttempts(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });
});
