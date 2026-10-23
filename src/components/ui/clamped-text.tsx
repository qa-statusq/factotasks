"use client";

import { useEffect, useRef, useState } from "react";
import { RichText } from "@/components/ui/rich-text";
import { cn } from "@/lib/cn";

const CLAMP: Record<number, string> = { 1: "line-clamp-1", 2: "line-clamp-2", 3: "line-clamp-3", 4: "line-clamp-4", 5: "line-clamp-5", 6: "line-clamp-6" };

/**
 * Text folded to `lines` lines with a More/Less toggle that appears ONLY when
 * the text really overflows — measured in the browser, not guessed from the
 * character count (a 230-character line and a 5-line note are both "long"
 * by count, but only one needs a button).
 */
export function ClampedText({ text, lines = 2, rich = false, className, buttonClassName, moreLabel = "More", lessLabel = "Less" }: { text: string | null | undefined; lines?: number; rich?: boolean; className?: string; buttonClassName?: string; moreLabel?: string; lessLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = text?.trim() ?? "";

  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    // Measured after paint (and again on any resize) so the button reflects
    // the actual wrapped height at this width.
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    const raf = window.requestAnimationFrame(measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [body, lines, open]);

  if (!body) return null;
  return (
    <div className={className}>
      <div ref={ref} className={cn("whitespace-pre-wrap break-words", !open && (CLAMP[lines] ?? "line-clamp-2"))}>
        {rich ? <RichText text={body} /> : body}
      </div>
      {(overflows || open) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className={cn("mt-0.5 text-[11.5px] font-medium text-brand-700 hover:text-brand-800", buttonClassName)}
        >
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
