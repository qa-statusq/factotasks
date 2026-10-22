"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonClass } from "@/components/ui/button";

/**
 * Branded render-error boundary. Without this file, an uncaught render error
 * showed Next's default unstyled crash screen; now the user gets a calm,
 * on-brand recovery card with a real retry (Next's reset() re-renders the
 * segment) and a full-reload escape hatch. The error itself still reaches the
 * server/browser logs — console.error survives the production build's
 * removeConsole exclusion list — but no internals are ever painted on screen.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[panel] render error:", error);
    // A chunk that no longer exists (new build deployed, dev rebuild mid-click)
    // is not a bug in the screen: one fresh load fixes it. Guarded so a real
    // error never loops.
    const stale = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch/i.test(`${error.name} ${error.message}`);
    if (!stale) return;
    try {
      // At most one automatic reload per 15 s: the stamp, not a timer, so the
      // reload itself can't leave a stale "already reloaded" flag behind.
      const key = "ft_reload_at";
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Date.now() - last < 15_000) return;
      sessionStorage.setItem(key, String(Date.now()));
      window.location.reload();
    } catch {}
  }, [error]);

  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center px-6 py-16 text-center">
      {/* Matches not-found.tsx exactly: big numeral, title, body, actions. */}
      <p
        aria-hidden="true"
        className="select-none text-[72px] font-bold leading-none tracking-[-0.05em] text-brand-600 tabular-nums sm:text-[88px]"
      >
        500
      </p>
      <h1 className="mt-5 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        Something went wrong on this screen
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">
        Your data is safe — this is only a display error. Try again, or reload the panel.
      </p>
      {/* flex-wrap: the two labels together are ~270px, which fits a 360px
          phone but not a 320px one (iPhone SE 1). Wrapping is free insurance —
          on every normal width the row is unchanged. */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        {/* next/link, not a scripted document navigation. This boundary catches a
            failure in ONE route segment — the root layout, the router and React
            are all still alive (that is exactly what separates this screen from
            global-error.tsx), and the "Try again" button beside it already
            depends on them. A Link also restores middle-click and
            open-in-new-tab, and is what a screen reader should announce for
            something that navigates. buttonClass keeps the look identical. */}
        <Link href="/" className={buttonClass("secondary")}>
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
