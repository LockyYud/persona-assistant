import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_MS = 60 * 1000;

export function signTickRequest(secret: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyTickSignature(
  secret: string,
  body: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
): boolean {
  if (!signatureHeader || !timestampHeader) return false;

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) return false;

  const expected = signTickRequest(secret, body, timestampHeader);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");

  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
