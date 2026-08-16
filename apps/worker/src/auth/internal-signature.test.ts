import { describe, expect, it } from "vitest";
import { signTickRequest, verifyTickSignature } from "./internal-signature.js";

describe("verifyTickSignature", () => {
  const secret = "test-secret";

  it("accepts a freshly signed request", () => {
    const body = "{}";
    const timestamp = String(Date.now());
    const signature = signTickRequest(secret, body, timestamp);

    expect(verifyTickSignature(secret, body, signature, timestamp)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Date.now());
    const signature = signTickRequest(secret, "{}", timestamp);

    expect(verifyTickSignature(secret, '{"x":1}', signature, timestamp)).toBe(false);
  });

  it("rejects an expired timestamp", () => {
    const body = "{}";
    const timestamp = String(Date.now() - 5 * 60 * 1000);
    const signature = signTickRequest(secret, body, timestamp);

    expect(verifyTickSignature(secret, body, signature, timestamp)).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifyTickSignature(secret, "{}", undefined, undefined)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const body = "{}";
    const timestamp = String(Date.now());
    const signature = signTickRequest("other-secret", body, timestamp);

    expect(verifyTickSignature(secret, body, signature, timestamp)).toBe(false);
  });
});
