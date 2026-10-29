"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Slide } from "./deck-slides";

/**
 * How the deck is driven: the toolbar that fades after a moment of stillness,
 * and the keyboard — arrows, Space, Page keys, Home/End, F for full screen,
 * A/J for the jump panel, 1–9 for the sections of the strip, Esc to leave.
 */

/** Controls fade after three seconds of stillness and come back on any movement,
 * so nothing sits over the slide while it is being presented. */
export function useIdleChrome(): { chrome: boolean; wake: () => void } {
  const [chrome, setChrome] = useState(true);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setChrome(false), 3000);
    return () => window.clearTimeout(idleTimer.current);
  }, []);
  return { chrome, wake };
}

/** The scrolling panel of the slide on screen, if it can scroll. */
function activePanel(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>("section.deck-slide:not(.opacity-0) [data-deck-scroll]");
  return el && el.scrollHeight > el.clientHeight + 2 ? el : null;
}

export function useDeckKeys(o: {
  slides: Slide[];
  last: number;
  next: () => void;
  prev: () => void;
  go: (n: number) => void;
  exit: () => void;
  toggleFullscreen: () => void;
  wake: () => void;
  jumpOpen: boolean;
  setJumpOpen: (f: (open: boolean) => boolean) => void;
}) {
  const { slides, last, next, prev, go, exit, toggleFullscreen, wake, jumpOpen, setJumpOpen } = o;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // An attachment viewer is open over the slides: its keys (← →, Esc) are its own.
      if (document.querySelector("[data-attachment-viewer]")) return;
      // A focused control keeps Space/Enter for itself ("Show more", the jump grid, the toolbar).
      const el = e.target as HTMLElement | null;
      if (e.key === " " && el && el.closest("button, a, input, textarea, select, [role=button]")) return;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          // Up/down scroll a long section first; at its end they turn the slide.
          const panel = activePanel();
          if (panel) {
            const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2;
            const atTop = panel.scrollTop <= 0;
            if (e.key === "ArrowDown" && !atBottom) {
              e.preventDefault();
              panel.scrollBy({ top: panel.clientHeight * 0.8, behavior: "smooth" });
              return;
            }
            if (e.key === "ArrowUp" && !atTop) {
              e.preventDefault();
              panel.scrollBy({ top: -panel.clientHeight * 0.8, behavior: "smooth" });
              return;
            }
          }
          e.preventDefault();
          (e.key === "ArrowDown" ? next : prev)();
          break;
        }
        case "ArrowRight":
        case " ":
        case "PageDown":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(last);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "Escape":
          if (jumpOpen) setJumpOpen(() => false);
          else if (!document.fullscreenElement) exit();
          break;
        case "a":
        case "A":
        case "j":
        case "J":
          setJumpOpen((open) => !open);
          break;
        default: {
          // 1–9 jump to the nth section of the strip.
          if (/^[1-9]$/.test(e.key)) {
            const jumps = slides.map((s, i) => (s.jump ? i : -1)).filter((i) => i >= 0);
            const target = jumps[Number(e.key) - 1];
            if (target !== undefined) go(target);
          }
        }
      }
    };
    const onAny = (e: KeyboardEvent) => {
      wake();
      onKey(e);
    };
    window.addEventListener("keydown", onAny);
    return () => window.removeEventListener("keydown", onAny);
  }, [next, prev, go, last, exit, toggleFullscreen, wake, jumpOpen, setJumpOpen, slides]);
}
