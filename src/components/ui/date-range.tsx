"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { controlClass } from "@/components/ui/field";
import { MonthGrid, usePopover, addDays, addMonths, daysBetween, istTodayYmd, parseYmd, prettyYmd } from "@/components/ui/date-input";
import { IconCalendar, IconX, IconCheck } from "@/components/ui/icons";

export interface DateRange {
  from: string;
  to: string;
}

interface Preset {
  id: string;
  label: string;
  build: (today: string) => DateRange;
}

const lastN = (t: string, n: number): DateRange => ({ from: addDays(t, -(n - 1)), to: t });
const monthStart = (t: string) => `${t.slice(0, 7)}-01`;
const monthEnd = (t: string) => {
  const p = parseYmd(t)!;
  return new Date(Date.UTC(p.y, p.m, 0)).toISOString().slice(0, 10);
};

const PRESETS: Preset[] = [
  { id: "today", label: "Today", build: (t) => ({ from: t, to: t }) },
  { id: "last7", label: "Last 7 days", build: (t) => lastN(t, 7) },
  { id: "last30", label: "Last 30 days", build: (t) => lastN(t, 30) },
  { id: "last90", label: "Last 90 days", build: (t) => lastN(t, 90) },
  { id: "thisMonth", label: "This month", build: (t) => ({ from: monthStart(t), to: monthEnd(t) }) },
  { id: "lastMonth", label: "Last month", build: (t) => { const prev = addDays(monthStart(t), -1); return { from: monthStart(prev), to: prev }; } },
  { id: "thisYear", label: "This year", build: (t) => ({ from: `${t.slice(0, 4)}-01-01`, to: `${t.slice(0, 4)}-12-31` }) },
];

/** Two months side by side only where there is room for them. */
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(min-width: 820px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 820px)").matches,
    () => true
  );
}

/**
 * Start and end date in ONE control. The trigger reads "22 Oct 2026 → 24 Oct
 * 2026 · 3 days" (or the preset's name) and grows to fit — no ellipsis. The
 * popover has quick ranges on the left and the calendar on the right (two
 * months on wide screens). First click sets the start, second the end; the
 * range previews under the pointer in between.
 */
export function DateRangeInput({ value, onChange, placeholder = "Any dates", className, min, max, allowClear = true }: { value: DateRange | null; onChange: (v: DateRange | null) => void; placeholder?: string; className?: string; min?: string; max?: string; allowClear?: boolean }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const wide = useWide();
  const today = istTodayYmd();
  const [draft, setDraft] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [view, setView] = useState(() => {
    const p = parseYmd(value?.to ?? today)!;
    // Wide: show the month before the end on the left so the range is visible.
    return { y: p.y, m: p.m };
  });
  const close = useMemo(
    () => () => {
      setOpen(false);
      setDraft(null);
      setHover(null);
    },
    []
  );
  const pos = usePopover(open, close, btnRef, popRef, 380, wide ? 760 : 300);
  const presets = useMemo(() => PRESETS.map((p) => ({ ...p, range: p.build(today) })), [today]);
  const matched = value ? presets.find((p) => p.range.from === value.from && p.range.to === value.to) : undefined;

  function openPicker() {
    const p = parseYmd(value?.to ?? today)!;
    setView(wide ? addMonths({ y: p.y, m: p.m }, -1) : { y: p.y, m: p.m });
    setFocusDay(value?.from ?? today);
    setOpen(true);
  }
  function pick(day: string) {
    if (!draft) {
      setDraft(day);
      setHover(null);
      return;
    }
    const [from, to] = draft <= day ? [draft, day] : [day, draft];
    onChange({ from, to });
    close();
    btnRef.current?.focus();
  }

  const label = value ? (value.from === value.to ? prettyYmd(value.from) : `${prettyYmd(value.from, { weekday: false })} → ${prettyYmd(value.to, { weekday: false })}`) : placeholder;
  const sub = value ? (matched ? matched.label : value.from === value.to ? "1 day" : `${daysBetween(value.from, value.to) + 1} days`) : null;
  const rangeForGrid = draft ? { from: draft, to: null } : value ? { from: value.from, to: value.to } : { from: null, to: null };
  const left = view;
  const right = addMonths(view, 1);

  return (
    <div className={cn("relative inline-flex", className)}>
      <button ref={btnRef} type="button" onClick={() => (open ? close() : openPicker())} aria-haspopup="dialog" aria-expanded={open} className={cn(controlClass, "flex h-10 w-auto max-w-full items-center gap-2 pl-3 pr-3 text-left", allowClear && value && "pr-9")}>
        <IconCalendar size={15} className="shrink-0 text-ink-subtle" />
        <span className={cn("min-w-0 truncate whitespace-nowrap tabular-nums", value ? "text-ink" : "text-ink-subtle")}>{label}</span>
        {sub && <span className="hidden whitespace-nowrap text-[12px] text-ink-subtle sm:inline">· {sub}</span>}
      </button>
      {allowClear && value && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-subtle hover:text-ink"
          aria-label="Clear dates"
        >
          <IconX size={13} />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div ref={popRef} role="dialog" aria-label="Choose a date range" className="fixed z-[320] flex max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop animate-fade-in sm:flex-row" style={{ left: pos.left, top: pos.top, transform: pos.up ? "translateY(-100%)" : undefined }}>
            {/* Quick ranges */}
            <div className="flex flex-wrap gap-1 border-b border-line/80 p-2 sm:w-[150px] sm:flex-col sm:flex-nowrap sm:gap-0.5 sm:border-b-0 sm:border-r">
              <div className="hidden px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle sm:block">Quick ranges</div>
              {presets.map((p) => {
                const active = matched?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onChange(p.range);
                      close();
                    }}
                    className={cn("flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors", active ? "bg-ink font-medium text-white" : "text-ink-muted hover:bg-canvas hover:text-ink")}
                  >
                    <span>{p.label}</span>
                    {active && <IconCheck size={13} />}
                  </button>
                );
              })}
              {allowClear && value && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    close();
                  }}
                  className="mt-auto rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-subtle hover:bg-canvas hover:text-ink"
                >
                  Clear
                </button>
              )}
            </div>
            {/* Calendar(s) */}
            <div className="p-3">
              <p className="mb-2 text-[11.5px] text-ink-subtle">{draft ? `Start ${prettyYmd(draft)} — now pick the end date` : "Pick a start date, then an end date"}</p>
              <div className="flex gap-5">
                <MonthGrid view={left} onView={setView} range={rangeForGrid} hover={hover} onHover={setHover} focusDay={focusDay} onFocusDay={setFocusDay} min={min} max={max} onPick={pick} showNav={wide ? "left" : true} hideOutside={wide} />
                {wide && <MonthGrid view={right} onView={(v) => setView(addMonths(v, -1))} range={rangeForGrid} hover={hover} onHover={setHover} focusDay={focusDay} onFocusDay={setFocusDay} min={min} max={max} onPick={pick} showNav="right" hideOutside />}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
