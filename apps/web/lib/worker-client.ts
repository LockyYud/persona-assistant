import "server-only";

const workerBaseUrl = process.env.WORKER_BASE_URL ?? "http://localhost:8787";
const sharedSecret = process.env.WORKER_BFF_SHARED_SECRET ?? "";

async function workerFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${workerBaseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${sharedSecret}`,
      "content-type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker request failed (${response.status}): ${text}`);
  }

  return response.json();
}

export async function verifyPassword(
  password: string,
  clientIp?: string,
): Promise<{ ok: boolean; email?: string }> {
  const response = await fetch(`${workerBaseUrl}/auth/verify-password`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sharedSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password, clientIp }),
    cache: "no-store",
  });

  if (!response.ok) return { ok: false };
  return (await response.json()) as { ok: boolean; email?: string };
}

export async function getCurrentUserId(email: string): Promise<string> {
  const data = (await workerFetch(`/users/me?email=${encodeURIComponent(email)}`)) as {
    user: { id: string };
  };
  return data.user.id;
}

export async function sendChatMessage(
  userId: string,
  message: string,
  conversationId?: string,
) {
  return workerFetch("/chat", {
    method: "POST",
    body: JSON.stringify({ userId, message, conversationId }),
  });
}

export async function listTasks(userId: string) {
  return workerFetch(`/tasks?userId=${encodeURIComponent(userId)}`);
}

export async function createTask(userId: string, input: Record<string, unknown>) {
  return workerFetch("/tasks", {
    method: "POST",
    body: JSON.stringify({ userId, ...input }),
  });
}

export async function decideApproval(
  userId: string,
  approvalId: string,
  decision: "approved" | "rejected",
) {
  return workerFetch(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ userId, decision }),
  });
}
