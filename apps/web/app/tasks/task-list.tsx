"use client";

import { useState } from "react";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  dueAt: string | null;
}

interface NowTasks {
  overdue: TaskRow[];
  today: TaskRow[];
  nextUp: TaskRow | null;
  unscheduledCount: number;
  unscheduled: TaskRow[];
}

function removeTask(now: NowTasks, taskId: string): NowTasks {
  return {
    ...now,
    overdue: now.overdue.filter((task) => task.id !== taskId),
    today: now.today.filter((task) => task.id !== taskId),
    nextUp: now.nextUp?.id === taskId ? null : now.nextUp,
  };
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatRelative(iso: string): string {
  const diffMinutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (diffMinutes < 0) return `overdue by ${formatDuration(-diffMinutes)}`;
  if (diffMinutes === 0) return "due now";
  return `due in ${formatDuration(diffMinutes)}`;
}

export function TaskList({ initialNow }: { initialNow: NowTasks }) {
  const [now, setNow] = useState(initialNow);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function handleComplete(taskId: string) {
    setError(null);
    const snapshot = now;
    setNow((prev) => removeTask(prev, taskId));
    setPendingIds((prev) => new Set(prev).add(taskId));

    try {
      const response = await fetch(`/api/tasks/${taskId}/complete`, { method: "POST" });
      if (!response.ok) throw new Error("request failed");
    } catch {
      setNow(snapshot);
      setError("Couldn't complete that task — try again.");
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  const hasAny = now.overdue.length > 0 || now.today.length > 0 || now.nextUp;

  return (
    <div className="now-view">
      {error && <p className="now-error">{error}</p>}
      <TaskGroup
        title="Overdue"
        tasks={now.overdue}
        tone="overdue"
        onComplete={handleComplete}
        pendingIds={pendingIds}
      />
      <TaskGroup
        title="Today"
        tasks={now.today}
        tone="today"
        onComplete={handleComplete}
        pendingIds={pendingIds}
      />
      {now.nextUp && (
        <TaskGroup
          title="Next up"
          tasks={[now.nextUp]}
          tone="next"
          onComplete={handleComplete}
          pendingIds={pendingIds}
        />
      )}
      {!hasAny && (
        <p className="empty-state">
          All clear. No overdue or due-today tasks.
          {now.unscheduledCount > 0 &&
            ` (${now.unscheduledCount} open task${now.unscheduledCount === 1 ? "" : "s"} with no due date — see All tasks.)`}
        </p>
      )}
      {hasAny && now.unscheduledCount > 0 && (
        <p className="task-meta">
          + {now.unscheduledCount} open task{now.unscheduledCount === 1 ? "" : "s"} with no due date — see All tasks.
        </p>
      )}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  tone,
  onComplete,
  pendingIds,
}: {
  title: string;
  tasks: TaskRow[];
  tone: "overdue" | "today" | "next";
  onComplete: (taskId: string) => void;
  pendingIds: Set<string>;
}) {
  if (tasks.length === 0) return null;

  return (
    <section className={`task-group task-group-${tone}`}>
      <h2>{title}</h2>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-card">
            <div className="task-card-row">
              <div>
                <div className="task-title">{task.title}</div>
                <div className="task-meta">
                  {task.type} · {task.priority}
                  {task.dueAt ? ` · ${formatRelative(task.dueAt)}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendingIds.has(task.id)}
                onClick={() => onComplete(task.id)}
              >
                Complete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
