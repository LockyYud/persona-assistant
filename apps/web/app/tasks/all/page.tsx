import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentUserId, listTasks } from "@/lib/worker-client";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
}

export default async function AllTasksPage() {
  const session = await auth();
  if (!session?.user?.email) return null;

  const userId = await getCurrentUserId(session.user.email);
  const { tasks } = (await listTasks(userId)) as { tasks: TaskRow[] };

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>All tasks</h1>
        <Link href="/tasks">Back to Now</Link>
      </header>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-card">
            <div className="task-title">{task.title}</div>
            <div className="task-meta">
              {task.status} · {task.priority}
              {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleString()}` : ""}
            </div>
          </li>
        ))}
        {tasks.length === 0 && <p className="empty-state">No tasks yet.</p>}
      </ul>
    </main>
  );
}
