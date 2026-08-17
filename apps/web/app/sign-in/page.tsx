import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="sign-in-shell">
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
        className="sign-in-card"
      >
        <h1>Persona Assistant</h1>
        <input name="password" type="password" placeholder="Password" autoFocus className="chat-input" />
        {error && <p className="sign-in-error">Sai mật khẩu hoặc thử lại quá nhiều lần.</p>}
        <button type="submit" className="btn btn-primary">
          Sign in
        </button>
      </form>
    </main>
  );
}
