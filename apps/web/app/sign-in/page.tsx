import { signIn } from "@/auth";

export default function SignInPage() {
  return (
    <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <form
        action={async () => {
          "use server";
          await signIn("google");
        }}
      >
        <button type="submit" style={{ padding: "0.75rem 1.5rem", fontSize: "1rem" }}>
          Sign in with Google
        </button>
      </form>
    </main>
  );
}
