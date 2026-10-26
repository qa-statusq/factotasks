"use client";

import { useEffect } from "react";
import { revalidateAllMounted } from "@/lib/client-cache";
import { timeoutSignal } from "@/lib/compat";

/**
 * Live-ish updates without WebSockets: while the tab is visible, poll the
 * server's change counter (/api/ping — one primary-key read) every
 * POLL_MS. When it moves, every screen currently on display re-fetches.
 * 50 people × one tiny request per 15 s is still nothing; a hidden tab polls
 * not at all, and focus/online revalidation (client-cache) still covers returns.
 */
const POLL_MS = 15_000;

// The last counter value this tab has reconciled with. Module-level so a
// write made from this tab can move it without waiting for the next poll.
let last: number | null = null;
// When the counter was last seen unchanged / reconciled: a tick that finds it moved
// refetches everything fetched before this moment, however recent.
let lastTickAt = 0;
let syncTimer = 0;

/**
 * Called after one of OUR writes succeeded: the client cache already painted
 * the change, so the counter is read once (debounced) and adopted. Without
 * this, the next poll saw "rev moved" and re-fetched every mounted screen —
 * a full refetch storm for a change this tab had just made itself.
 */
export function syncRevAfterOwnWrite() {
  if (typeof window === "undefined") return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(async () => {
    try {
      const r = await fetch("/api/ping", { signal: timeoutSignal(8_000), cache: "no-store" });
      if (r.ok) {
        last = ((await r.json()) as { rev: number }).rev;
        lastTickAt = Date.now();
      }
    } catch {
      /* the regular poll will reconcile */
    }
  }, 600);
}

export function useLiveUpdates(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let timer = 0;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        try {
          const r = await fetch("/api/ping", { signal: timeoutSignal(8_000), cache: "no-store" });
          if (r.ok) {
            const { rev } = (await r.json()) as { rev: number };
            const since = lastTickAt;
            lastTickAt = Date.now();
            if (last !== null && rev !== last) revalidateAllMounted(since);
            last = rev;
          }
        } catch {
          /* transient — try again next tick */
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    // A tab coming back to the foreground checks right away instead of
    // waiting out the remainder of its interval.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}
