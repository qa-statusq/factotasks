"use client";

import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

/**
 * Segmented control: a quiet track, the selected segment lifted as a white
 * tab with a hairline shadow — nothing floats with dead space around it.
 * Keyboard: arrow keys move the selection (native radio semantics via
 * role="radiogroup").
 */
export function Segmented<T extends string>({ value, onChange, options, size = "md", className, "aria-label": ariaLabel }: { value: T; onChange: (v: T) => void; options: SegmentOption<T>[]; size?: "sm" | "md"; className?: string; "aria-label"?: string }) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex shrink-0 items-stretch rounded-lg bg-brand-100/80 p-[3px]", className)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = options[(idx + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
        if (next) onChange(next.value);
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-[background-color,color,box-shadow] duration-150",
              size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]",
              on ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)]" : "text-ink-muted hover:text-ink"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
