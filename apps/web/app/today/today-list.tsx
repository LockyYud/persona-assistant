"use client";

import { useState } from "react";
import type { TodaySessionRow } from "@/lib/worker-client";

function minutes(value: number) {
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ""}` : `${rest}m`;
}

function time(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(value))
    : null;
}

function localTimeInput(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: timezone,
      }).format(new Date(value))
    : "";
}

function zonedTimeToIso(date: string, value: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = value.split(":").map(Number);
  const wallClock = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let utc = wallClock;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    utc = wallClock - (represented - utc);
  }
  return new Date(utc).toISOString();
}

export function TodayList({ initialSessions, timezone }: { initialSessions: TodaySessionRow[]; timezone: string }) {
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
    const rawTime = window.prompt(
      "Giờ bắt đầu (HH:MM, để trống = bất kỳ lúc nào hôm nay)",
      localTimeInput(session.startAt, timezone),
    );
    if (rawTime === null) return;
    const normalizedTime = rawTime.trim();
    let startAt: string | null = null;
    if (normalizedTime) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)) {
        setError("Giờ bắt đầu phải có dạng HH:MM.");
        return;
      }
      startAt = zonedTimeToIso(session.date, normalizedTime, timezone);
    }
    setBusy(session.id);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, taskId: session.taskId, plannedMinutes, focusText: focusText || null, startAt }),
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
              <span className="today-meta">{minutes(session.plannedMinutes)}{time(session.startAt, timezone) ? ` · ${time(session.startAt, timezone)}` : ""}</span>
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
