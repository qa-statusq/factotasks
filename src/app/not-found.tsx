import Link from "next/link";
import TabTitle from "@/components/tab-title";
import { buttonClass } from "@/components/ui/button";

/**
 * Branded 404. Without this file, an unknown path rendered Next's default
 * black-on-white error screen — the one surface in the panel that ignored the
 * design system entirely. Renders inside the shell for signed-in users
 * (unauthenticated visitors never reach it: the proxy bounces them to
 * /login before any route resolves). Server component on purpose — nothing
 * here needs state, so it adds zero client JS beyond the tab title.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center px-6 py-16 text-center">
      <TabTitle title="Page not found · FactoTasks" />
      {/* The status code IS the artwork: one large brand-coloured numeral, no
          box, no gradient, no glow — the panel's own highlight colour doing the
          work. tabular-nums keeps the three digits evenly spaced, and
          aria-hidden stops a screen reader from announcing a bare number ahead
          of the heading that actually explains the screen. */}
      <p
        aria-hidden="true"
        className="select-none text-[72px] font-bold leading-none tracking-[-0.05em] text-brand-600 tabular-nums sm:text-[88px]"
      >
        404
      </p>
      <h1 className="mt-5 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        This page doesn&rsquo;t exist
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">
        The link may be old, or the page may have moved. Everything you need is still on the dashboard.
      </p>
      <Link href="/" className={buttonClass("primary", "md", "mt-7")}>
        Go to dashboard
      </Link>
    </div>
  );
}
