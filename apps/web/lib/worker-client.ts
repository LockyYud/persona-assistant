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

export async function listNowTasks(userId: string) {
  return workerFetch(`/tasks/now?userId=${encodeURIComponent(userId)}`) as Promise<{
    now: {
      overdue: TaskRow[];
      today: TaskRow[];
      nextUp: TaskRow | null;
      unscheduledCount: number;
      unscheduled: TaskRow[];
    };
  }>;
}

export async function completeTask(userId: string, taskId: string) {
  return workerFetch(`/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  dueAt: string | null;
  /** Step counts, or null when the task has no steps at all. */
  progress: { done: number; total: number } | null;
  /** Earliest unfinished step, when the task has been broken down. */
  nextStep: { id: string; title: string } | null;
}

export interface DesktopTokenRow {
  id: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function listDesktopTokens(userId: string) {
  return workerFetch(`/auth/desktop-tokens?userId=${encodeURIComponent(userId)}`) as Promise<{
    tokens: DesktopTokenRow[];
  }>;
}

export async function mintDesktopToken(userId: string, label: string) {
  return workerFetch("/auth/desktop-tokens", {
    method: "POST",
    body: JSON.stringify({ userId, label }),
  }) as Promise<{ token: DesktopTokenRow; raw: string }>;
}

export async function revokeDesktopToken(userId: string, tokenId: string) {
  return workerFetch(`/auth/desktop-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
    body: JSON.stringify({ userId }),
  });
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
