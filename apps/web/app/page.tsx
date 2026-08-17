import Link from "next/link";
import { auth, signOut } from "@/auth";
import { ChatPanel } from "./chat-panel";

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Persona Assistant</h1>
        <nav>
          <Link href="/tasks">Tasks</Link>
          <span className="user-email">{session?.user?.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button type="submit" className="btn">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <ChatPanel />
    </main>
  );
}
