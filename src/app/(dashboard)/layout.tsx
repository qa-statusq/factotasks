import type { Metadata } from "next";

/** Route group (no URL segment) purely so "/" can carry its own server-rendered tab title. */
export const metadata: Metadata = { title: "Dashboard" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
