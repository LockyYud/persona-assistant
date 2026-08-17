import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main
      style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}
    >
      <form
        action={async (formData: FormData) => {
          "use server";
          try {
            await signIn("credentials", { ...Object.fromEntries(formData), redirectTo: "/" });
          } catch (err) {
            if (err instanceof AuthError) {
              const { redirect } = await import("next/navigation");
              redirect("/sign-in?error=1");
            }
            throw err;
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: 280 }}
      >
        <h1 style={{ fontSize: "1.1rem", margin: 0 }}>Persona Assistant</h1>
        <input
          name="password"
          type="password"
          placeholder="Password"
          autoFocus
          style={{ padding: "0.6rem", fontSize: "1rem" }}
        />
        {error && (
          <p style={{ color: "#c0392b", fontSize: "0.85rem", margin: 0 }}>
            Sai mật khẩu hoặc thử lại quá nhiều lần.
          </p>
        )}
        <button type="submit" style={{ padding: "0.65rem 1.5rem", fontSize: "1rem" }}>
          Sign in
        </button>
      </form>
    </main>
  );
}
