"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { controlClass } from "@/components/ui/field";
import { IconCalendar, IconX, IconChevronLeft, IconChevronRight } from "@/components/ui/icons";

/* ------------------------------- helpers ---------------------------------- */

export const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export function parseYmd(v: string): { y: number; m: number; d: number; h: number; min: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v || "");
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 10, min: m[5] ? +m[5] : 0 };
}
export function addDays(k: string, n: number): string {
  const p = parseYmd(k)!;
  return new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86_400_000).toISOString().slice(0, 10);
}
export function addMonths(view: { y: number; m: number }, n: number): { y: number; m: number } {
  const d = new Date(Date.UTC(view.y, view.m - 1 + n, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
export function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a)!;
  const pb = parseYmd(b)!;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}
/** "Sat, 24 Oct 2026" — the full date, never abbreviated into an ellipsis. */
export function prettyYmd(k: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const p = parseYmd(k);
  if (!p) return "";
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString("en-IN", { ...(opts.weekday !== false ? { weekday: "short" } : {}), day: "numeric", month: "short", ...(opts.year !== false ? { year: "numeric" } : {}), timeZone: "UTC" });
}
/** Today in IST as YYYY-MM-DD (for min/max). */
export const istTodayYmd = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
/** Now in IST as YYYY-MM-DDTHH:MM (datetime-local value). */
export const istNowLocal = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 16);
/** datetime-local (IST wall clock) → ISO instant. */
export const istLocalToIso = (v: string) => (v ? new Date(Date.parse(`${v}:00Z`) - 5.5 * 3600_000).toISOString() : "");

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* -------------------------------- popover --------------------------------- */

/** Fixed-position popover under (or above) an anchor, in a portal; closes on outside click / Escape. */
export function usePopover(open: boolean, close: () => void, anchorRef: React.RefObject<HTMLElement | null>, popRef: React.RefObject<HTMLElement | null>, height: number, width: number) {
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < height + 12 && r.top > height + 12;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos({ left, top: up ? r.top - 6 : r.bottom + 6, up });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        (anchorRef.current as HTMLElement | null)?.focus?.();
      }
    };
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, anchorRef, popRef, height, width]);
  return pos;
}

/* -------------------------------- month grid ------------------------------ */

/**
 * One month. Single selection, or a range (start/end + a hover preview while
 * the end is still being chosen). Keyboard: arrows move, Enter picks,
 * PageUp/PageDown change month.
 */
export function MonthGrid({ view, onView, selected, range, hover, onHover, focusDay, onFocusDay, min, max, onPick, showNav = true, hideOutside = false }: { view: { y: number; m: number }; onView: (v: { y: number; m: number }) => void; selected?: string | null; range?: { from: string | null; to: string | null }; hover?: string | null; onHover?: (d: string | null) => void; focusDay: string | null; onFocusDay: (d: string) => void; min?: string; max?: string; onPick: (d: string) => void; showNav?: boolean | "left" | "right"; hideOutside?: boolean }) {
  const today = istTodayYmd();
  const gridRef = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(view.y, view.m - 1, 1));
    const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
    const start = new Date(first.getTime() - offset * 86_400_000);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getTime() + i * 86_400_000);
      return { key: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === view.m - 1 };
    });
  }, [view]);
  const disabled = (k: string) => (!!min && k < min.slice(0, 10)) || (!!max && k > max.slice(0, 10));
  const shift = (n: number) => onView(addMonths(view, n));

  // Range painting: a complete range, or start + hovered preview.
  const rs = range?.from ?? null;
  const re = range?.to ?? (range?.from && hover ? hover : null);
  const lo = rs && re ? (rs <= re ? rs : re) : rs;
  const hi = rs && re ? (rs <= re ? re : rs) : rs;

  useEffect(() => {
    if (!focusDay) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`);
    if (el && document.activeElement && gridRef.current?.contains(document.activeElement)) el.focus();
  }, [focusDay, cells]);

  function onKey(e: React.KeyboardEvent) {
    const cur = focusDay ?? selected ?? rs ?? today;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      const next = addDays(cur, step[e.key]);
      onFocusDay(next);
      onHover?.(next);
      const [y, m] = next.split("-").map(Number);
      if (y !== view.y || m !== view.m) onView({ y, m });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!disabled(cur)) onPick(cur);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      shift(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      shift(1);
    }
  }

  const navL = showNav === true || showNav === "left";
  const navR = showNav === true || showNav === "right";
  return (
    <div className="w-[276px]">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => shift(-1)} className={cn("rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink", !navL && "invisible")} aria-label="Previous month" tabIndex={navL ? 0 : -1}>
          <IconChevronLeft size={16} />
        </button>
        <div className="text-[13.5px] font-semibold text-ink">
          {MONTHS[view.m - 1]} {view.y}
        </div>
        <button type="button" onClick={() => shift(1)} className={cn("rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink", !navR && "invisible")} aria-label="Next month" tabIndex={navR ? 0 : -1}>
          <IconChevronRight size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-y-0.5" onKeyDown={onKey} onMouseLeave={() => onHover?.(null)}>
        {cells.map((c) => {
          if (hideOutside && !c.inMonth) return <span key={c.key} className="h-8" aria-hidden />;
          const isSel = c.key === selected;
          const isStart = !!lo && c.key === lo;
          const isEnd = !!hi && c.key === hi;
          const inRange = !!lo && !!hi && c.key > lo && c.key < hi;
          const isToday = c.key === today;
          const dis = disabled(c.key);
          return (
            <div key={c.key} className={cn("flex justify-center", inRange && "bg-ink/[0.06]", isStart && hi && hi !== lo && "rounded-l-full bg-gradient-to-r from-transparent from-50% to-ink/[0.06] to-50%", isEnd && lo && hi !== lo && "rounded-r-full bg-gradient-to-l from-transparent from-50% to-ink/[0.06] to-50%")}>
              <button
                type="button"
                data-day={c.key}
                tabIndex={(focusDay ?? selected ?? rs ?? today) === c.key ? 0 : -1}
                disabled={dis}
                onClick={() => onPick(c.key)}
                onFocus={() => onFocusDay(c.key)}
                onMouseEnter={() => onHover?.(c.key)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors",
                  isSel || isStart || isEnd ? "bg-ink font-semibold text-white" : inRange ? "text-ink hover:bg-ink/10" : "hover:bg-canvas",
                  !(isSel || isStart || isEnd) && (c.inMonth ? "text-ink" : "text-ink-subtle/70"),
                  !(isSel || isStart || isEnd) && isToday && "font-semibold ring-1 ring-inset ring-ink/40",
                  dis && "cursor-not-allowed opacity-30 hover:bg-transparent"
                )}
                aria-pressed={isSel || isStart || isEnd}
                aria-label={c.key}
              >
                {c.day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------ single date ------------------------------- */

/**
 * Date (or date-and-time) field with a proper picker: a calendar popover
 * with quick picks, and a 12-hour time row when `withTime`. Values stay the
 * plain strings the rest of the panel speaks — "YYYY-MM-DD", or
 * "YYYY-MM-DDTHH:MM" wall-clock IST for date-times. The trigger shows the
 * full date and grows to fit; it never clips into an ellipsis.
 */
export function DateInput({ value, onChange, min, max, withTime, placeholder, className, clearable = true, id: idProp }: { value: string; onChange: (v: string) => void; min?: string; max?: string; withTime?: boolean; placeholder?: string; className?: string; clearable?: boolean; id?: string }) {
  const auto = useId();
  const id = idProp ?? auto;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => parseYmd(value), [value]);
  const [view, setView] = useState(() => {
    const p = parseYmd(value) ?? parseYmd(istTodayYmd())!;
    return { y: p.y, m: p.m };
  });
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const close = useMemo(() => () => setOpen(false), []);
  const pos = usePopover(open, close, btnRef, popRef, withTime ? 400 : 348, 300);

  function openPicker() {
    const p = parseYmd(value) ?? parseYmd(istTodayYmd())!;
    setView({ y: p.y, m: p.m });
    setFocusDay(ymd(p.y, p.m, p.d));
    setOpen(true);
  }
  const label = parsed ? `${prettyYmd(ymd(parsed.y, parsed.m, parsed.d))}${withTime ? ` · ${parsed.h % 12 === 0 ? 12 : parsed.h % 12}:${pad(parsed.min)} ${parsed.h >= 12 ? "pm" : "am"}` : ""}` : placeholder || (withTime ? "Pick date & time" : "Pick a date");

  function pickDay(d: string) {
    if (withTime) {
      const t = parsed ?? { h: 10, min: 0 };
      onChange(`${d}T${pad(t.h)}:${pad(t.min)}`);
    } else {
      onChange(d);
      setOpen(false);
      btnRef.current?.focus();
    }
  }
  function setTime(h: number, min: number) {
    const base = parsed ? ymd(parsed.y, parsed.m, parsed.d) : istTodayYmd();
    onChange(`${base}T${pad(h)}:${pad(min)}`);
  }

  return (
    <div className={cn("relative inline-flex w-full", className)}>
      <button ref={btnRef} id={id} type="button" onClick={() => (open ? setOpen(false) : openPicker())} aria-haspopup="dialog" aria-expanded={open} className={cn(controlClass, "flex h-10 w-full items-center gap-2 pl-3 text-left", clearable && value && "pr-9")}>
        <IconCalendar size={15} className="shrink-0 text-ink-subtle" />
        <span className={cn("min-w-0 flex-1 whitespace-nowrap tabular-nums", parsed ? "text-ink" : "text-ink-subtle")}>{label}</span>
      </button>
      {clearable && value && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange("");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-subtle hover:text-ink"
          aria-label="Clear date"
        >
          <IconX size={13} />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div ref={popRef} role="dialog" aria-label="Choose a date" className="fixed z-[320] rounded-xl border border-line bg-surface p-3 shadow-pop animate-fade-in" style={{ left: pos.left, top: pos.top, transform: pos.up ? "translateY(-100%)" : undefined }}>
            <MonthGrid view={view} onView={setView} selected={parsed ? ymd(parsed.y, parsed.m, parsed.d) : null} focusDay={focusDay} onFocusDay={setFocusDay} min={min} max={max} onPick={pickDay} />
            {withTime && <TimeRow h={parsed?.h ?? 10} min={parsed?.min ?? 0} onChange={setTime} />}
            <div className="mt-2.5 flex items-center justify-between border-t border-line/70 pt-2.5">
              <div className="flex flex-wrap gap-1">
                <Quick label="Today" onClick={() => pickDay(istTodayYmd())} />
                <Quick label="Tomorrow" onClick={() => pickDay(addDays(istTodayYmd(), 1))} />
                <Quick label="Next week" onClick={() => pickDay(addDays(istTodayYmd(), 7))} />
              </div>
              {withTime && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    btnRef.current?.focus();
                  }}
                  className="rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-black"
                >
                  Done
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export function Quick({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded-md px-2 py-1 text-[11.5px] font-medium ring-1 ring-inset", active ? "bg-ink text-white ring-ink" : "bg-canvas text-ink-muted ring-line hover:text-ink")}>
      {label}
    </button>
  );
}

function TimeRow({ h, min, onChange }: { h: number; min: number; onChange: (h: number, m: number) => void }) {
  const pm = h >= 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const sel = cn(controlClass, "h-9 appearance-none px-2 text-center text-[13px] tabular-nums");
  const set = (hh12: number, mm: number, isPm: boolean) => onChange((hh12 % 12) + (isPm ? 12 : 0), mm);
  return (
    <div className="mt-2.5 flex items-center gap-2 border-t border-line/70 pt-2.5">
      <span className="text-[12px] font-medium text-ink-muted">Time</span>
      <select value={h12} onChange={(e) => set(Number(e.target.value), min, pm)} className={cn(sel, "w-16")} aria-label="Hour">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      <span className="text-ink-subtle">:</span>
      <select value={min} onChange={(e) => set(h12, Number(e.target.value), pm)} className={cn(sel, "w-16")} aria-label="Minutes">
        {Array.from({ length: 12 }, (_, i) => i * 5).map((x) => (
          <option key={x} value={x}>
            {pad(x)}
          </option>
        ))}
        {min % 5 !== 0 && <option value={min}>{pad(min)}</option>}
      </select>
      <div className="ml-auto inline-flex rounded-lg bg-canvas p-[3px] ring-1 ring-inset ring-line" role="radiogroup" aria-label="AM or PM">
        {(["AM", "PM"] as const).map((p) => {
          const on = (p === "PM") === pm;
          return (
            <button key={p} type="button" role="radio" aria-checked={on} onClick={() => set(h12, min, p === "PM")} className={cn("rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors", on ? "bg-surface text-ink shadow-xs" : "text-ink-muted hover:text-ink")}>
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}
