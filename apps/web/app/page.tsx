import Link from "next/link";
import { auth, signOut } from "@/auth";
import { ChatPanel } from "./chat-panel";

export default async function HomePage() {
  const session = await auth();

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "1.5rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: "1.25rem" }}>Persona Assistant</h1>
        <nav style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <Link href="/tasks">Tasks</Link>
          <span style={{ color: "#666" }}>{session?.user?.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      <ChatPanel />
    </main>
  );
}
