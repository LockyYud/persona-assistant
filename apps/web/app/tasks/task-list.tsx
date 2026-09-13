"use client";

import { useState } from "react";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  dueAt: string | null;
  progress: { done: number; total: number } | null;
  nextStep: { id: string; title: string } | null;
  pace: Pace | null;
}

interface Pace {
  targetMinutes: number;
  spentMinutes: number;
  deltaMinutes: number;
  status: "ahead" | "on_track" | "behind";
  dayOfMonth: number;
  daysInMonth: number;
  suggestedTodayMinutes: number;
}

interface NowTasks {
  overdue: TaskRow[];
  today: TaskRow[];
  nextUp: TaskRow | null;
  unscheduledCount: number;
  unscheduled: TaskRow[];
  ongoing: TaskRow[];
}

function removeTask(now: NowTasks, taskId: string): NowTasks {
  return {
    ...now,
    overdue: now.overdue.filter((task) => task.id !== taskId),
    today: now.today.filter((task) => task.id !== taskId),
    nextUp: now.nextUp?.id === taskId ? null : now.nextUp,
  };
}

/**
 * Kept local rather than imported from the worker's pace module: this app has
 * no @persona/* dependency, and adding one would put building that package
 * ahead of `next build` in a deploy pipeline configured outside the repo.
 * Mirrors formatMinutes in apps/worker/src/services/pace.ts.
 */
function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h${rest}m`;
}

function describeStanding(pace: Pace): string {
  const gap = formatMinutes(Math.abs(pace.deltaMinutes));
  if (pace.status === "behind") return `chậm ${gap}`;
  if (pace.status === "ahead") return `vượt ${gap}`;
  return "đúng nhịp";
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

  // A behind routine is exactly the state the old check missed: it has no
  // dueAt, so it lands in none of the dated buckets and the view claimed
  // "all clear" while the month was slipping.
  const hasAny =
    now.overdue.length > 0 || now.today.length > 0 || now.nextUp || now.ongoing.length > 0;

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
        title="Due today"
        tasks={now.today}
        tone="today"
        onComplete={handleComplete}
        pendingIds={pendingIds}
      />
      <RoutineGroup tasks={now.ongoing} />
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

/**
 * Routines get their own group and no Complete button. The button on an
 * ordinary card finishes the task; on a routine it would end the routine
 * itself, which is not what anyone reaching for a row that says "behind
 * 5h" intends. Minutes are logged from the widget, so this view reports.
 */
function RoutineGroup({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) return null;

  return (
    <section className="task-group task-group-routine">
      <h2>Routine</h2>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-card">
            <div className="task-title">{task.title}</div>
            {/* A routine is held out of the dated buckets, so if it also
                carries a deadline this card is the only place on the page
                that can show it. */}
            {task.dueAt && <div className="task-meta">{formatRelative(task.dueAt)}</div>}
            {task.pace && (
              <>
                <div className={`task-meta pace-${task.pace.status}`}>
                  {formatMinutes(task.pace.spentMinutes)} / {formatMinutes(task.pace.targetMinutes)}{" "}
                  tháng này · {describeStanding(task.pace)} · ngày {task.pace.dayOfMonth}/
                  {task.pace.daysInMonth}
                </div>
                {task.pace.suggestedTodayMinutes > 0 && (
                  <div className="task-next-step">
                    Đề xuất hôm nay: ~{formatMinutes(task.pace.suggestedTodayMinutes)}
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
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
                <div className="task-title">
                  {task.title}
                  {task.progress && (
                    <span className="task-progress">
                      {" "}
                      {task.progress.done}/{task.progress.total}
                    </span>
                  )}
                </div>
                <div className="task-meta">
                  {task.type} · {task.priority}
                  {task.dueAt ? ` · ${formatRelative(task.dueAt)}` : ""}
                </div>
                {task.nextStep && (
                  <div className="task-next-step">Tiếp: {task.nextStep.title}</div>
                )}
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
