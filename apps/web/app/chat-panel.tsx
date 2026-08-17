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
    <section className="chat-card">
      <div className="chat-messages">
        {entries.length === 0 && (
          <p className="chat-empty">Nhắn gì đó để bắt đầu — ví dụ &quot;tạo task mua sữa mai 8h&quot;.</p>
        )}
        {entries.map((entry, index) => (
          <div key={index} className={`chat-row ${entry.role}`}>
            <span className="bubble">{entry.text}</span>
            {entry.pendingApproval && !entry.resolved && (
              <div className="approval-actions">
                <button onClick={() => decide(index, "approved")} className="btn btn-primary">
                  ✅ Xác nhận
                </button>
                <button onClick={() => decide(index, "rejected")} className="btn btn-danger">
                  ❌ Huỷ
                </button>
              </div>
            )}
            {entry.resolved && (
              <div className="approval-resolved">
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
        className="chat-form"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Nhắc tôi..."
          className="chat-input"
        />
        <button type="submit" disabled={pending} className="btn btn-primary">
          Send
        </button>
      </form>
    </section>
  );
}
