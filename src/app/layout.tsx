import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";
import AppShell, { type NavHint } from "@/components/app-shell";
import { getSessionUser } from "@/lib/auth";
import SwRegister from "@/components/sw-register";

// Variable font: ONE woff2 covering every weight (no weight array, or next/font
// would emit and preload several static files ahead of first text paint).
const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

export const metadata: Metadata = {
  // Each route segment exports just its own name (see the layout.tsx beside
  // each page) and Next renders "<name> · FactoTasks" on the FIRST paint.
  title: {
    default: "FactoTasks — Mobile team task tracker",
    template: "%s · FactoTasks",
  },
  description: "Task tracking, releases and weekly MOM for the mobile app team — by Version Systems.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "FactoTasks" },
  icons: {
    icon: [
      { url: "/favicon.ico?v=4", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { url: "/favicon-32.png?v=4", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-192.png?v=4", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/favicon.ico?v=4",
    apple: "/apple-touch-icon.png?v=4",
  },
};

// Mobile browser chrome tints to match the canvas, so the panel reads as one
// continuous surface on phones.
export const viewport: Viewport = {
  themeColor: "#f7f7f5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Render every route per-request so the proxy's one-time CSP nonce is stamped
// onto Next's scripts. This panel is auth-gated and fetches data client-side,
// so there's no static-caching benefit lost.
export const dynamic = "force-dynamic";

/** The sidebar for this person, known before any script runs: the role comes from
 * the verified session cookie (no database read), series membership from the
 * small `ft_nav` hint the shell keeps current — honoured only for the same person. */
async function navHint(): Promise<NavHint> {
  const u = await getSessionUser();
  if (!u) return { admin: false, series: false };
  const hint = (await cookies()).get("ft_nav")?.value ?? "";
  return { admin: u.role === "admin", series: hint === `${u.uid.slice(0, 8)}.s` };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <SwRegister />
        <AppShell navHint={await navHint()}>{children}</AppShell>
      </body>
    </html>
  );
}
