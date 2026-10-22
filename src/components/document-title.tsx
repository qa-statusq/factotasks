"use client";

import { usePathname } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle, usePageTitle } from "@/lib/use-document-title";

const BRAND = "FactoTasks";

/** Per-route browser tab title. Client pages can't export `metadata`, so the
 * title is set on navigation here (mounted once in the shell). Screens that
 * know a richer title (a task's "T-12 · title") override it themselves. */
function titleFor(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (pathname.startsWith("/tasks/")) return "Task";
  if (pathname.startsWith("/tasks")) return "Tasks";
  if (pathname.startsWith("/apps/")) return "App";
  if (pathname.startsWith("/apps")) return "Apps";
  if (pathname.startsWith("/releases")) return "Releases";
  if (pathname.startsWith("/approvals")) return "Approvals";
  if (pathname.startsWith("/meetings/")) return "Meeting";
  if (pathname.startsWith("/meetings")) return "Meetings";
  if (pathname.startsWith("/analytics") || pathname.startsWith("/reports")) return "Analytics";
  if (pathname.startsWith("/team")) return "Team";
  if (pathname.startsWith("/activity")) return "Activity";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/profile")) return "Profile";
  if (pathname.startsWith("/notifications")) return "Inbox";
  if (pathname.startsWith("/guide")) return "Help & guide";
  if (pathname.startsWith("/shortcuts")) return "Keyboard shortcuts";
  return "Page not found";
}

export default function DocumentTitle() {
  const pathname = usePathname();
  // Same cached call the bell uses — zero extra requests. Unread notifications
  // prefix the tab title so a pending approval is visible from another tab.
  const { data } = useCachedFetch<{ unread?: number }>("/api/notifications?limit=1");
  const unread = data?.unread || 0;
  const page = usePageTitle();
  const base = page ?? `${titleFor(pathname)} · ${BRAND}`;
  // While a screen owns the title, the shell only adds the unread prefix.
  useDocumentTitle(unread > 0 ? `(${unread}) ${base}` : page ? "" : base, { shell: true });
  return null;
}
