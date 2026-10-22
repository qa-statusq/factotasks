"use client";

import { useState } from "react";

/**
 * Run `reset` once, DURING RENDER, whenever `key` changes.
 *
 * This is React's documented "adjusting state when a prop changes" pattern
 * (react.dev/learn/you-might-not-need-an-effect). Calling a setter of the SAME
 * component during render is explicitly supported: React discards the in-progress
 * output and immediately re-renders with the new state, before anything is
 * committed to the DOM.
 *
 * It replaces the shape this codebase used everywhere:
 *
 *     useEffect(() => { setDraft(null); setPage(0); }, [open]);
 *
 * which is a render → commit → paint → effect → setState → SECOND render cycle.
 * The user could see one frame of the stale value, and `react-hooks/set-state-in-effect`
 * flags it for exactly that reason. Resetting during render collapses it to one
 * commit, so the reset value is what actually paints — the same reason
 * apps/[appId]/page.tsx already derives `loading` instead of setting it in an
 * effect (an effect-set flag left one painted frame of the old list).
 *
 * `reset` must only call setters belonging to the calling component. Anything
 * else — a fetch, a parent's setter, a DOM write — is a side effect and still
 * belongs in an effect.
 */
export function useOnChange<T>(key: T, reset: () => void): void {
  const [prev, setPrev] = useState(key);
  if (!Object.is(prev, key)) {
    setPrev(key);
    reset();
  }
}
