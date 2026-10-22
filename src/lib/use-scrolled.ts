"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "./use-latest";

/**
 * True once the window has scrolled past `threshold` pixels. Used to reveal the
 * scroll-to-top button and the condensed app header only after the user has
 * scrolled — and hide them again at the top. Passive listener; no layout cost.
 */
export function useScrolled(threshold = 300): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll(); // initialise for a mid-page reload
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

/**
 * Detects when a sticky bar has ACTUALLY stuck to the top — by watching a
 * zero-height sentinel placed right above it — instead of guessing from a scroll
 * threshold. Tie the bar's lifted styling (border/shadow) and any condensed
 * header to `stuck` so the transition fires exactly when it reaches the top: the
 * jitter-free, premium way. Handles the responsive top inset (mobile header vs
 * flush desktop) and re-arms on resize. Degrades to never-stuck if
 * IntersectionObserver is unavailable.
 */
/** Live height of the connection strip (NetworkStrip publishes it on <html>
 * as --offline-h) — 0px while online. Every JS sticky-offset constant must
 * include it, or stuck-detection and anchor scrolls run 36px off while the
 * strip is visible. */
export function offlineStripHeight(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--offline-h"), 10) || 0;
}

/** Default sticky top inset: 0 on desktop (flush), ~56px under the mobile
 * header — plus the connection strip when it's showing. */
export function defaultStickyOffset(): number {
  return (window.matchMedia("(min-width: 1024px)").matches ? 0 : 56) + offlineStripHeight();
}

export function useStuck(topOffset: () => number = defaultStickyOffset) {
  const [stuck, setStuck] = useState(false);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useLatest(topOffset);

  const arm = useCallback((el: HTMLDivElement | null) => {
    obsRef.current?.disconnect();
    obsRef.current = null;
    elRef.current = el;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const offset = offsetRef.current();
    const obs = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      rootMargin: `-${offset + 1}px 0px 0px 0px`,
      threshold: 0,
    });
    obs.observe(el);
    obsRef.current = obs;
    // offsetRef is a stable ref object (useLatest) — listing it keeps `arm`
    // identity-stable while being honest about what the callback reads.
  }, [offsetRef]);

  // A CALLBACK ref (not a ref object): React invokes it with the element the
  // instant it mounts — including AFTER a loading skeleton resolves and the
  // sentinel finally renders — and with null on unmount. This is what makes the
  // "stuck" styling work on a FRESH page load, where the bar renders only once
  // data arrives (a plain-ref effect ran once while the sentinel was still null
  // and never re-attached the observer).
  const sentinelRef = useCallback((el: HTMLDivElement | null) => arm(el), [arm]);

  // Re-arm on resize so the mobile/desktop top inset stays correct.
  useEffect(() => {
    const onResize = () => arm(elRef.current);
    // Connectivity changes move the sticky boundary too (the connection strip
    // adds --offline-h to every top inset). Re-arm after the strip's 300ms
    // layout transition settles, and again after the reconnect flash collapses
    // (~2.5s after 'online') — the observer's rootMargin is baked at arm time.
    let t1: number | undefined, t2: number | undefined;
    const onNet = () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
      t1 = window.setTimeout(onResize, 400);
      t2 = window.setTimeout(onResize, 3200);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
      obsRef.current?.disconnect();
    };
  }, [arm]);

  // elRef.current is the sentinel element — exposed so callers can measure the
  // sticky bar's natural top for scroll targeting.
  return { sentinelRef, stuck, elRef };
}
