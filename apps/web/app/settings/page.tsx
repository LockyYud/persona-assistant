import Link from "next/link";
import { auth } from "@/auth";
import { getCurrentUserId, listDesktopTokens } from "@/lib/worker-client";
import { DesktopTokens } from "./desktop-tokens";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.email) return null;

  const userId = await getCurrentUserId(session.user.email);
  const { tokens } = await listDesktopTokens(userId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Settings</h1>
        <Link href="/">Back to chat</Link>
      </header>
      <section className="settings-section">
        <h2>Connect this desktop</h2>
        <p className="task-meta">
          Waybar, Vicinae, and the local CLI read tasks through a token scoped to just that: reading
          tasks, completing them, and snoozing a due date forward by up to a week. It never has access
          to anything else this account can do.
        </p>
        <DesktopTokens initialTokens={tokens} />
      </section>
    </main>
  );
}
