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

export default async function TasksPage() {
  const session = await auth();
  if (!session?.user?.email) return null;

  const userId = await getCurrentUserId(session.user.email);
  const { tasks } = (await listTasks(userId)) as { tasks: TaskRow[] };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "1.5rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: "1.25rem" }}>Tasks</h1>
        <Link href="/">Back to chat</Link>
      </header>
      <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
        {tasks.map((task) => (
          <li
            key={task.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              marginBottom: "0.5rem",
            }}
          >
            <div style={{ fontWeight: 600 }}>{task.title}</div>
            <div style={{ color: "#666", fontSize: "0.875rem" }}>
              {task.status} · {task.priority}
              {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleString()}` : ""}
            </div>
          </li>
        ))}
        {tasks.length === 0 && <p style={{ color: "#666" }}>No tasks yet.</p>}
      </ul>
    </main>
  );
}
