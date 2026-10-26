"use client";

import { useEffect, useState } from "react";

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