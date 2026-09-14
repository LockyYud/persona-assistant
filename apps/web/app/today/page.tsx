import Link from "next/link";
import { auth, signOut } from "@/auth";
import { getCurrentUserId, getToday, listNowTasks } from "@/lib/worker-client";
import { TodayList } from "./today-list";

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.email) return null;
  const userId = await getCurrentUserId(session.user.email);
  const [{ timezone, sessions, missedYesterday, ongoing }, { now }] = await Promise.all([getToday(userId), listNowTasks(userId)]);
  const activeTodayTaskIds = new Set(
    sessions.filter((item) => item.status !== "cancelled").map((item) => item.taskId),
  );
  const attention = [
    ...now.overdue.map((task) => ({ task, label: "overdue" })),
    ...now.today.map((task) => ({ task, label: "due today" })),
    ...ongoing.filter((task) => task.pace?.status === "behind").map((task) => ({ task, label: "behind pace" })),
    ...(now.nextUp ? [{ task: now.nextUp, label: "upcoming" }] : []),
  ]
    .filter(({ task }) => !activeTodayTaskIds.has(task.id))
    .filter(({ task }, index, all) => all.findIndex((entry) => entry.task.id === task.id) === index)
    .slice(0, 5);
  return (
    <main className="app-shell">
      <header className="app-header"><h1>Today</h1><nav><Link href="/">Today</Link><Link href="/tasks">Tasks</Link><Link href="/chat">Chat</Link><Link href="/settings">Settings</Link><span className="user-email">{session.user.email}</span><form action={async () => { "use server"; await signOut(); }}><button type="submit" className="btn">Sign out</button></form></nav></header>
      <TodayList initialSessions={sessions} timezone={timezone} />
      {missedYesterday.length > 0 && <section className="today-section"><h2>Unfinished</h2>{missedYesterday.map((item) => <p key={item.id}>{item.task.title}{item.focusText ? ` · ${item.focusText}` : ""} · {item.plannedMinutes}m</p>)}</section>}
      <section className="today-section"><h2>Needs attention</h2>{attention.length === 0 ? <p className="empty-state">Không có mục cần chú ý.</p> : attention.map(({ task, label }) => <p key={task.id}>{task.title} · {label}</p>)}</section>
    </main>
  );
}
