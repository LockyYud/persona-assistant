import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const allowedEmail = process.env.AUTH_ALLOWED_EMAIL;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  callbacks: {
    signIn({ profile }) {
      if (!allowedEmail) return false;
      return profile?.email === allowedEmail;
    },
    session({ session }) {
      return session;
    },
  },
  pages: {
    signIn: "/sign-in",
  },
});
