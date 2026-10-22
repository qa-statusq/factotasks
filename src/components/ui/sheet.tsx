"use client";

import { useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useModalChrome, useBackdropClose } from "@/components/ui/use-modal-chrome";
import { IconX } from "@/components/ui/icons";

const subscribeNever = () => () => {};

/**
 * The panel's one modal surface for forms: a right-hand SHEET on desktop
 * (keeps the page visible behind it — the user never loses their place) and a
 * full-height bottom sheet on phones. Escape / backdrop / ✕ close it; focus is
 * trapped inside and returned to the opener on close; body scroll is locked.
 * Portaled to <body> so position:fixed resolves against the real viewport.
 */
export function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  labelledBy,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalChrome(onClose, panelRef);
  const backdrop = useBackdropClose(onClose);
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-end bg-ink/50 sm:items-stretch"
      {...backdrop}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        className={cn(
          // Phone: bottom sheet that can reach the top of the screen. Desktop:
          // a right-hand column the full height of the viewport.
          "flex max-h-[94svh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-pop ring-1 ring-ink/5 outline-none animate-slide-up",
          "sm:max-h-none sm:h-full sm:animate-slide-in-right sm:rounded-none sm:rounded-l-2xl sm:border-l sm:border-line",
          wide ? "sm:w-[720px] sm:max-w-[92vw]" : "sm:w-[520px] sm:max-w-[92vw]"
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="tap -mr-1.5 -mt-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-canvas hover:text-ink"
            aria-label="Close"
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-line bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
