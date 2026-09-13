"use client";

import { useState } from "react";
import type { TodaySessionRow } from "@/lib/worker-client";

function minutes(value: number) {
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ""}` : `${rest}m`;
}

function time(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : null;
}

export function TodayList({ initialSessions }: { initialSessions: TodaySessionRow[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "complete" | "skip" | "cancel") {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("request failed");
      const { session } = (await response.json()) as { session: TodaySessionRow };
      setSessions((items) => items.map((item) => (item.id === id ? { ...item, ...session } : item)));
    } catch {
      setError("Không thể cập nhật commitment. Hãy thử lại.");
    } finally {
      setBusy(null);
    }
  }

  async function replan(session: TodaySessionRow) {
    const rawMinutes = window.prompt("Thời lượng mới (phút)", String(session.plannedMinutes));
    if (rawMinutes === null) return;
    const plannedMinutes = Number(rawMinutes);
    if (!Number.isInteger(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 24 * 60) {
      setError("Thời lượng phải là số phút hợp lệ.");
      return;
    }
    const focusText = window.prompt("Focus hôm nay", session.focusText ?? "");
    if (focusText === null) return;
    setBusy(session.id);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, taskId: session.taskId, plannedMinutes, focusText: focusText || null }),
      });
      if (!response.ok) throw new Error("request failed");
      const { session: revised } = (await response.json()) as { session: TodaySessionRow };
      setSessions((items) => items.map((item) => (item.id === session.id ? { ...item, ...revised } : item)));
    } catch {
      setError("Không thể lập lại commitment. Hãy thử lại.");
    } finally {
      setBusy(null);
    }
  }

  const active = sessions.filter((session) => session.status === "planned");
  const total = active.reduce((sum, session) => sum + session.plannedMinutes, 0);
  return (
    <section className="today-card">
      <p className="today-total">Planned: {minutes(total)}</p>
      {error && <p className="form-error">{error}</p>}
      {active.length === 0 && <p className="empty-state">Chưa có commitment nào hôm nay. Hãy nhờ Chat lập kế hoạch.</p>}
      <ol className="today-list">
        {active.map((session) => (
          <li key={session.id} className="today-item">
            <div className="today-item-main">
              <strong>{session.focusText || session.task.title}</strong>
              {session.focusText && <span className="today-task">{session.task.title}</span>}
              <span className="today-meta">{minutes(session.plannedMinutes)}{time(session.startAt) ? ` · ${time(session.startAt)}` : ""}</span>
            </div>
            <div className="today-actions">
              <button className="btn btn-primary" disabled={busy === session.id} onClick={() => void act(session.id, "complete")}>Done</button>
              <button className="btn" disabled={busy === session.id} onClick={() => void act(session.id, "skip")}>Skip</button>
              <button className="btn" disabled={busy === session.id} onClick={() => void replan(session)}>Replan</button>
              <button className="btn btn-danger" disabled={busy === session.id} onClick={() => void act(session.id, "cancel")}>Remove</button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
