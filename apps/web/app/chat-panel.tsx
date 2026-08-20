"use client";

import { useCallback, useEffect, useState } from "react";

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

interface ConversationRow {
  id: string;
  title: string | null;
  channel: "web" | "telegram";
  messageCount: number;
  updatedAt: string;
}

function conversationLabel(conversation: ConversationRow): string {
  // A thread is listed as soon as it has messages, which can be before the
  // title call has finished — fall back rather than showing a blank row.
  return conversation.title?.trim() || "Hội thoại chưa đặt tên";
}

export function ChatPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [pending, setPending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Distinguishes "the user clicked New chat" from "nothing sent yet": without
  // it, the first message would continue the most recent thread instead of
  // opening a new one.
  const [forceNew, setForceNew] = useState(false);

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) return;
      const data = (await response.json()) as { conversations: ConversationRow[] };
      setConversations(data.conversations ?? []);
    } catch {
      // A failed sidebar refresh must not disturb the conversation itself.
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  async function openConversation(id: string) {
    if (id === conversationId || pending) return;
    setLoadingHistory(true);
    try {
      const response = await fetch(`/api/conversations/${id}/messages`);
      if (!response.ok) return;
      const data = (await response.json()) as {
        messages: { role: "user" | "assistant"; content: string }[];
      };
      setEntries(data.messages.map((m) => ({ role: m.role, text: m.content })));
      setConversationId(id);
      setForceNew(false);
    } finally {
      setLoadingHistory(false);
    }
  }

  function startNewChat() {
    if (pending) return;
    setEntries([]);
    setConversationId(undefined);
    setForceNew(true);
    setInput("");
  }

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
        body: JSON.stringify({
          message,
          conversationId,
          startNewConversation: forceNew || undefined,
        }),
      });
      // An error response is often an HTML error page, which would throw on
      // .json() and land in the catch below as if the request never happened.
      if (!response.ok) throw new Error(`chat failed (${response.status})`);

      const data = await response.json();
      setConversationId(data.conversationId);
      setForceNew(false);
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply ?? "(no reply)",
          pendingApproval: data.pendingApproval ?? undefined,
        },
      ]);
      void refreshConversations();
    } catch {
      // The turn may well have completed on the server even though the
      // response never arrived, so don't claim the message was lost — and
      // refresh the list, since the thread it created will be there.
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Không nhận được phản hồi (có thể do quá thời gian chờ). Tin nhắn có thể vẫn đã được xử lý — mở lại hội thoại ở danh sách bên trái để kiểm tra.",
        },
      ]);
      void refreshConversations();
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
    <div className="chat-layout">
      <aside className="conversation-sidebar">
        <button type="button" className="btn btn-primary new-chat-btn" onClick={startNewChat}>
          + Hội thoại mới
        </button>
        <ul className="conversation-list">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                onClick={() => void openConversation(conversation.id)}
                className={`conversation-item${conversation.id === conversationId ? " active" : ""}`}
              >
                <span className="conversation-title">{conversationLabel(conversation)}</span>
                {conversation.channel === "telegram" && (
                  <span className="conversation-badge">Telegram</span>
                )}
              </button>
            </li>
          ))}
          {conversations.length === 0 && (
            <li className="conversation-empty">Chưa có hội thoại nào.</li>
          )}
        </ul>
      </aside>

      <section className="chat-card">
        <div className="chat-messages">
          {entries.length === 0 && !loadingHistory && (
            <p className="chat-empty">Nhắn gì đó để bắt đầu — ví dụ &quot;tạo task mua sữa mai 8h&quot;.</p>
          )}
          {loadingHistory && <p className="chat-empty">Đang tải hội thoại…</p>}
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
            placeholder={forceNew ? "Bắt đầu hội thoại mới…" : "Nhắc tôi..."}
            className="chat-input"
          />
          <button type="submit" disabled={pending} className="btn btn-primary">
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
