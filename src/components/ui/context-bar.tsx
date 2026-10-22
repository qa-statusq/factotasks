"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * A slim, FIXED context bar that slides in once the page header has scrolled
 * away, so the user always knows where they are — the current app (icon + name)
 * on an app page, or the screen name (Reports, Team, …) elsewhere. Styled as a
 * proper white header (like the mobile top bar), not a gray strip.
 *
 * Rendered in a PORTAL on document.body (like the app's modals): position:fixed
 * resolves against the real viewport, never against an ancestor that happens to
 * create a containing block (transform/filter from page animations). Fixed +
 * portal also means ZERO layout space. Below the mobile header, flush on desktop
 * (offset by the sidebar), above sticky toolbars (z-30) and below modals.
 *
 * Same background as the sticky filter toolbar (bg-canvas), so when both are
 * stuck they read as ONE continuous surface. `flat` drops the bottom shadow AND
 * the divider — used when the Reviews filter toolbar sits directly beneath, so
 * the two merge seamlessly and only the LOWEST bar casts the section's shadow.
 */
/** Nothing to subscribe to — the "client has hydrated" answer never changes. */
const subscribeNever = () => () => {};

export function StickyContextBar({
  show,
  flat = false,
  children,
}: {
  show: boolean;
  flat?: boolean;
  children: React.ReactNode;
}) {
  // createPortal needs a DOM, so this renders nothing until the client has
  // taken over. useSyncExternalStore answers that AT RENDER TIME (server
  // snapshot false, client snapshot true) — the old mounted flag needed a
  // setState in an effect, i.e. a guaranteed second render on every mount.
  // subscribeNever is module-level so its identity is stable; the value can
  // never change after hydration, so there is nothing to subscribe to.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!mounted) return null;
  return createPortal(
    <div
      className={cn(
        // Top offsets include --offline-h (the connection strip's height, set
        // on <html> by the shell) so this bar stacks BELOW the strip when the
        // connection is down instead of being painted over.
        "fixed left-0 right-0 top-[calc(3.5rem+var(--offline-h,0px))] z-30 border-b bg-canvas transition-[opacity,transform,top] duration-200 ease-out motion-reduce:transition-none lg:left-64 lg:top-[var(--offline-h,0px)]",
        flat ? "border-transparent" : "border-line shadow-[0_8px_18px_-14px_rgba(15,23,42,0.30)]",
        show ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
      )}
      aria-hidden={!show}
    >
      <div className="mx-auto flex h-10 max-w-[1600px] items-center gap-2.5 px-4 sm:px-6 lg:px-10 xl:px-14">
        {children}
      </div>
    </div>,
    document.body
  );
}
