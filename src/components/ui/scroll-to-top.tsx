"use client";

import { useScrolled } from "@/lib/use-scrolled";
import { smoothScrollToTop } from "@/lib/compat";

/**
 * A floating "back to top" button that appears only after the user scrolls down
 * and smoothly returns to the top on click. Mounted once in the app shell, so it
 * covers every scrollable screen (dashboard, app pages, reports…). Sits clear of
 * the bottom edge and below dialogs (z-30 < modal z-100).
 */
export function ScrollToTop() {
  const show = useScrolled(400);
  return (
    <button
      type="button"
      // Compat helper: old Safari treats scrollTo(options) as a SILENT NO-OP —
      // this button did nothing there. Falls back to an instant jump.
      onClick={smoothScrollToTop}
      aria-label="Scroll to top"
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      // bottom offset adds --bottom-bar-h so this never sits on top of a page's
      // fixed action bar (it overlapped the Add app bar by 29px before).
      className={`fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom)+1rem)+var(--bottom-bar-h,0px))] right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink-muted shadow-pop ring-1 ring-ink/5 transition-all duration-200 hover:border-brand-200 hover:bg-canvas hover:text-brand-700 sm:right-6 lg:bottom-[calc(2.25rem+var(--bottom-bar-h,0px))] lg:right-9 ${
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
