"use client";

import { useState } from "react";

interface PendingApproval {
  approvalId: string;
  action: string;
  payload: unknown;
}

interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  pendingApproval?: PendingApproval;
  resolved?: "approved" | "rejected";
}

export function ChatPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function sendMessage() {
    const message = input.trim();
    if (!message || pending) return;

    setEntries((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setPending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });
      const data = await response.json();
      setConversationId(data.conversationId);
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply ?? "(no reply)",
          pendingApproval: data.pendingApproval ?? undefined,
        },
      ]);
    } catch {
      setEntries((prev) => [...prev, { role: "assistant", text: "Error sending message." }]);
    } finally {
      setPending(false);
    }
  }

  async function decide(entryIndex: number, decision: "approved" | "rejected") {
    const approval = entries[entryIndex]?.pendingApproval;
    if (!approval) return;

    try {
      await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: approval.approvalId, decision }),
      });
    } finally {
      setEntries((prev) =>
        prev.map((entry, index) => (index === entryIndex ? { ...entry, resolved: decision } : entry)),
      );
    }
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          minHeight: 320,
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        {entries.map((entry, index) => (
          <div key={index} style={{ textAlign: entry.role === "user" ? "right" : "left" }}>
            <span
              style={{
                display: "inline-block",
                padding: "0.5rem 0.75rem",
                borderRadius: 8,
                background: entry.role === "user" ? "#1a73e8" : "#f1f1f1",
                color: entry.role === "user" ? "#fff" : "#111",
                maxWidth: "80%",
              }}
            >
              {entry.text}
            </span>
            {entry.pendingApproval && !entry.resolved && (
              <div style={{ marginTop: "0.4rem" }}>
                <button onClick={() => decide(index, "approved")} style={{ marginRight: "0.5rem" }}>
                  ✅ Xác nhận
                </button>
                <button onClick={() => decide(index, "rejected")}>❌ Huỷ</button>
              </div>
            )}
            {entry.resolved && (
              <div style={{ marginTop: "0.25rem", fontSize: "0.85rem", color: "#666" }}>
                {entry.resolved === "approved" ? "Đã xác nhận." : "Đã huỷ."}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage();
        }}
        style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Nhắc tôi..."
          style={{ flex: 1, padding: "0.5rem" }}
        />
        <button type="submit" disabled={pending}>
          Send
        </button>
      </form>
    </section>
  );
}
