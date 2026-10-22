"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

// useLayoutEffect on the client, useEffect during SSR (React warns that layout
// effects cannot run on the server). Same guard app-shell.tsx already uses.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The "latest ref" pattern, in one place.
 *
 * Several hooks here deliberately keep a value in a ref so a long-lived
 * subscription (an event listener, an IntersectionObserver, a fetch callback)
 * can read the CURRENT value without being torn down and re-created on every
 * render. Each of them used to do it by assigning during render:
 *
 *     const onCloseRef = useRef(onClose);
 *     onCloseRef.current = onClose;   // <- render-phase mutation
 *
 * That works, but it mutates during render, which React's own rules forbid and
 * the compiler-era `react-hooks/refs` rule flags: a render may be thrown away
 * or replayed, so nothing outside the returned tree may be written from it.
 *
 * The sync happens in a LAYOUT effect, not a passive one. Layout effects run
 * synchronously after DOM mutation and before paint — earlier than any user
 * interaction, timer or network callback can possibly fire — so every reader in
 * this codebase still observes the value from the render it was committed with.
 * A passive useEffect would leave a real (if narrow) window where a handler
 * dispatched during commit reads a stale value.
 *
 * Read the result ONLY from callbacks and effects, never during render — that
 * is the whole point, and reading it in render would just re-introduce the
 * same rule violation from the other side.
 */
export function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  useIsoLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
