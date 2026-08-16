import { createHmac } from "node:crypto";

/**
 * Invoked by EventBridge Scheduler every minute. Signs an empty JSON body and
 * calls the worker's /internal/tick. On repeated failure the invocation goes
 * to the configured SQS DLQ per the EventBridge Scheduler retry policy.
 */
export async function handler(): Promise<void> {
  const workerBaseUrl = process.env.WORKER_BASE_URL;
  const secret = process.env.WORKER_INTERNAL_HMAC_SECRET;
  if (!workerBaseUrl || !secret) {
    throw new Error("WORKER_BASE_URL and WORKER_INTERNAL_HMAC_SECRET are required");
  }

  const body = "{}";
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  const response = await fetch(`${workerBaseUrl}/internal/tick`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signature,
      "x-timestamp": timestamp,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`tick invocation failed: ${response.status} ${await response.text()}`);
  }
}
