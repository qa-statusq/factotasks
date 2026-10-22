"use client";

import { cn } from "@/lib/cn";

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  disabledTitle,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
  /** Read-only: the value is shown but this account may not write it. Renders
   * an honestly-inert control instead of one that flips and snaps back on the
   * server's 400. */
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      {(label || description) && (
        <div className="flex flex-col gap-0.5">
          {label && <div className="text-sm font-medium text-ink">{label}</div>}
          {description && <div className="text-xs text-ink-subtle">{description}</div>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2",
          checked ? "bg-brand-600" : "bg-slate-300",
          disabled ? "cursor-not-allowed opacity-50" : !checked && "hover:bg-slate-400/70"
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200",
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
