import type { Metadata } from "next";
import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Azumo Workspaces",
  description: "Notion-inspired workspaces prototype",
};

/**
 * Root layout. The appearance preference (Light / Dark / System, E1) is a
 * per-device cookie rendered here as `<html data-theme>`, so the very first
 * paint already uses the right colors: no theme flash and no inline script
 * (DP11). Reading a cookie touches no database or session, so `/sign-in`
 * stays a cheap readiness probe.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
