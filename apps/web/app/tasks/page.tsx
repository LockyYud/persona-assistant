import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentUserId, listNowTasks } from "@/lib/worker-client";
import { TaskList } from "./task-list";

export default async function TasksPage() {
  const session = await auth();
  if (!session?.user?.email) return null;

  const userId = await getCurrentUserId(session.user.email);
  const { now } = await listNowTasks(userId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Now</h1>
        <nav>
          <Link href="/">Back to chat</Link>
          <Link href="/tasks/all">All tasks</Link>
        </nav>
      </header>
      <TaskList initialNow={now} />
    </main>
  );
}
