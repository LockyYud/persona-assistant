import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyPassword } from "@/lib/worker-client";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { password: { type: "password" } },
      async authorize(credentials, request) {
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!password) return null;

        const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

        const result = await verifyPassword(password, clientIp);
        if (!result.ok) return null;

        return { id: "duy", email: result.email };
      },
    }),
  ],
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
    jwt({ token, user }) {
      if (user?.email) token.email = user.email;
      return token;
    },
    session({ session, token }) {
      if (token.email) session.user.email = token.email;
      return session;
    },
  },
  pages: {
    signIn: "/sign-in",
  },
});
