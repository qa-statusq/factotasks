"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Set the browser-tab title — and KEEP it.
 *
 * Next writes <title> from the route's resolved `metadata` on the CLIENT too,
 * after hydration and after every client navigation. A plain
 * `document.title = ...` inside an effect is therefore reverted a moment later:
 * measured on the 404 screen, the effect ran, set the title, and the metadata
 * commit had overwritten it again within the same second.
 *
 * That silently broke the two titles Next's metadata cannot express:
 *   - the 404 screen — `not-found.tsx` is not allowed to export `metadata`, so
 *     an unknown path always fell back to the app-wide default title; and
 *   - the "(3) " unread prefix, which depends on client-fetched data and so can
 *     never be part of a server-resolved metadata object.
 *
 * So we set the title, then watch <head> and re-apply ours if a later commit
 * clobbers it. Corrections are capped: if a future framework change ever wrote
 * the title back in a loop, this stops rather than spinning.
 */
const MAX_CORRECTIONS = 10;

// Which page title (if any) is registered right now. The shell's route title
// stands down while a screen sets its own, so the two never fight over
// <title> (each used to correct the other up to the cap).
let pageTitle: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export function usePageTitle(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => pageTitle,
    () => null
  );
}

export function useDocumentTitle(title: string, opts?: { shell?: boolean }): void {
  const shell = !!opts?.shell;
  useEffect(() => {
    if (!title || shell) return;
    pageTitle = title;
    emit();
    return () => {
      if (pageTitle === title) {
        pageTitle = null;
        emit();
      }
    };
  }, [title, shell]);
  useEffect(() => {
    if (!title) return;
    let corrections = 0;
    document.title = title;
    // Observe <head>, not the <title> node: React may REPLACE the element
    // rather than edit its text, and a replaced node would stop reporting.
    // The `!==` guard makes this a no-op for the many unrelated head mutations
    // (font/style injection) and for our own writes.
    const mo = new MutationObserver(() => {
      if (document.title === title || corrections >= MAX_CORRECTIONS) return;
      corrections++;
      document.title = title;
    });
    mo.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [title]);
}
