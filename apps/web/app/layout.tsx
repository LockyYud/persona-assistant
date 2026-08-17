import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Persona Assistant",
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
