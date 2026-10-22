"use client";

import { useSyncExternalStore } from "react";

/**
 * A single shared 30s ticker exposed as an external store. Components that show
 * a relative timestamp call useClock() to subscribe — only THOSE components
 * re-render each tick, not their parents, so "x minutes ago" / "Synced x ago"
 * keep counting up without any refresh or server call and without reconciling
 * whole pages/lists. Prefer the leaf <RelTime>/<RelTimeLong> components so the
 * subscription stays at the smallest possible node.
 */
const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      tick++;
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// Immediate catch-up tick on tab wake: browsers throttle/suspend intervals in
// background tabs, so after a long stay away the next scheduled tick can be up
// to a minute out — leaving every "x ago" label showing its frozen value while
// freshly revalidated data repaints around it (user-reported on the dashboard
// card). Ticking synchronously on visible/pageshow snaps all labels to now.
if (typeof window !== "undefined") {
  const wake = () => {
    if (document.visibilityState !== "visible" || listeners.size === 0) return;
    tick++;
    listeners.forEach((l) => l());
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("pageshow", wake);
}

const getSnapshot = () => tick;
const getServerSnapshot = () => 0; // stable across SSR → no hydration mismatch

export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Kept as a passthrough so existing app-shell wiring is untouched. */
export function ClockProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
