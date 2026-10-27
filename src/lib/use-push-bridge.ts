"use client";

import { useEffect } from "react";
import { mutate, mutatePrefix } from "@/lib/client-cache";
import { useToast } from "@/components/ui/toast";

const BADGE_KEY = "/api/notifications?limit=1";

/**
 * The page side of push, mounted once in the shell:
 *  - a push that lands refreshes the inbox badge in every open tab at once,
 *    instead of at the next 15-second poll;
 *  - when the system notification was held back because this tab already shows
 *    the page it points to, the news appears here as a quiet note instead
 *    (never during a presentation);
 *  - the app icon (installed app) carries the unread count, like any mail or chat app.
 */
export function usePushBridge(unread: number) {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; shownBySystem?: boolean; quiet?: boolean; title?: string; body?: string } | null;
      if (!d || d.type !== "ft-push") return;
      mutate(BADGE_KEY);
      mutatePrefix("/api/notifications?limit=30");
      if (!d.shownBySystem && !d.quiet && document.visibilityState === "visible") toast(d.title || "New notification", "info", d.body || undefined);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [toast]);

  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (unread > 0 ? nav.setAppBadge(unread) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [unread]);
}
