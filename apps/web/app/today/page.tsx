import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentUserId, getToday, listNowTasks } from "@/lib/worker-client";
import { TodayList } from "./today-list";

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.email) return null;
  const userId = await getCurrentUserId(session.user.email);
  const [{ sessions, missedYesterday, ongoing }, { now }] = await Promise.all([getToday(userId), listNowTasks(userId)]);
  const attention = [...now.overdue, ...(now.nextUp ? [now.nextUp] : []), ...ongoing.filter((task) => task.pace?.status === "behind")].slice(0, 5);
  return (
    <main className="app-shell">
      <header className="app-header"><h1>Today</h1><nav><Link href="/tasks">Tasks</Link><Link href="/">Chat</Link><Link href="/settings">Settings</Link></nav></header>
      <TodayList initialSessions={sessions} />
      {missedYesterday.length > 0 && <section className="today-section"><h2>Unfinished</h2>{missedYesterday.map((item) => <p key={item.id}>{item.task.title}{item.focusText ? ` · ${item.focusText}` : ""} · {item.plannedMinutes}m</p>)}</section>}
      <section className="today-section"><h2>Needs attention</h2>{attention.length === 0 ? <p className="empty-state">Không có mục cần chú ý.</p> : attention.map((task) => <p key={task.id}>{task.title}{task.pace?.status === "behind" ? " · behind pace" : task.dueAt ? " · due soon" : ""}</p>)}</section>
    </main>
  );
}
