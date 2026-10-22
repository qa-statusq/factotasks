"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared, lazily-built date formatters: toLocaleDateString(opts) constructs a
 * fresh Intl.DateTimeFormat per CALL, and these run per bar/label/tooltip per
 * render. One formatter per shape, reused across every chart. All UTC — the
 * inputs are plain YYYY-MM-DD strings, so no timezone drift.
 */
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtUtc(s: string, opts: Intl.DateTimeFormatOptions & { key: string }): string {
  const [y, m, dd] = s.split("-").map(Number);
  let f = dateFmtCache.get(opts.key);
  if (!f) {
    const { key: _key, ...rest } = opts;
    f = new Intl.DateTimeFormat(undefined, { ...rest, timeZone: "UTC" });
    dateFmtCache.set(opts.key, f);
  }
  return f.format(new Date(Date.UTC(y, m - 1, dd ?? 1)));
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** Donut chart with a centered total. */
export function Donut({
  segments,
  size = 132,
  thickness = 16,
  centerLabel,
  centerValue,
}: {
  segments: Segment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: React.ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0f3" strokeWidth={thickness} />
        {total > 0 &&
          segments.map((s, i) => {
            const frac = s.value / total;
            const dash = frac * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += dash;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
        <span className="max-w-full truncate text-2xl font-semibold tabular-nums tracking-tight text-ink">
          {centerValue ?? total}
        </span>
        {centerLabel && <span className="max-w-full truncate text-xs text-ink-subtle">{centerLabel}</span>}
      </div>
    </div>
  );
}

export function Legend({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <ul className="flex flex-col gap-2 min-w-0">
      {segments.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-sm">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
          <span className="min-w-0 flex-1 truncate text-ink-muted">{s.label}</span>
          <span className="shrink-0 font-medium tabular-nums text-ink">{s.value}</span>
          <span className="w-11 shrink-0 text-right text-xs tabular-nums text-ink-subtle">
            {Math.round((s.value / total) * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars for the 1–5 star distribution, with a count above each bar. */
export function RatingBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="flex h-44 items-end gap-3">
      {counts.map((v, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <span className="text-sm font-semibold tabular-nums text-ink">{v}</span>
          <div className="flex w-full flex-1 items-end">
            <div
              // transition-colors, NOT transition-all: the inline height is a
              // layout property — animating it on a data swap ran a layout+
              // paint pass per frame per bar for the transition duration.
              className="w-full rounded-t-md bg-amber-400 transition-colors hover:bg-amber-500"
              style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? 6 : 0 }}
              title={`${v} review${v === 1 ? "" : "s"} · ${Math.round((v / total) * 100)}%`}
            />
          </div>
          <span className="text-xs font-medium text-ink-subtle">{i + 1}★</span>
        </div>
      ))}
    </div>
  );
}

/** Daily series (e.g. replies per day) with a count above each bar and the
 *  day-of-month under each, plus the date range. `labels="month"` renders one
 *  bar per month (long custom ranges), labelled "Jul", "Aug", … */
export function DaySeries({ data, labels = "day" }: { data: { date: string; count: number }[]; labels?: "day" | "month" }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const monthly = labels === "month";
  // Format a YYYY-MM-DD string as "Jun 10" / "Jun 2026" without timezone drift.
  const monthDay = (s: string) =>
    monthly ? fmtUtc(s, { key: "my", month: "short", year: "numeric" }) : fmtUtc(s, { key: "md", month: "short", day: "numeric" });
  const shortMonth = (s: string) => fmtUtc(s, { key: "m", month: "short" });
  if (data.length === 0) return <ChartEmpty />;
  return (
    <div>
      <div className="flex h-32 items-end gap-1.5">
        {data.map((d) => (
          <div key={d.date} className="group flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] font-semibold leading-none tabular-nums text-ink">{d.count > 0 ? d.count : ""}</span>
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t bg-blue-500/80 transition-colors group-hover:bg-blue-600"
                style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count > 0 ? 4 : 0 }}
                title={`${monthDay(d.date)} · ${d.count} repl${d.count === 1 ? "y" : "ies"}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d) => (
          <span key={d.date} className="flex-1 text-center text-[10px] leading-none tabular-nums text-ink-subtle">
            {monthly ? shortMonth(d.date) : Number(d.date.slice(8, 10))}
          </span>
        ))}
      </div>
      <div className="mt-2 text-center text-[11px] text-ink-subtle">
        {monthDay(data[0].date)} – {monthDay(data[data.length - 1].date)}
      </div>
    </div>
  );
}

export interface LineDef {
  label: string;
  color: string;
  values: number[]; // one value per date, index-aligned with `dates`
}

/**
 * Multi-line time series (e.g. reviews per day by star rating). Pure SVG
 * polylines over an integer y-axis: ticks are whole counts (step = ceil(max/4),
 * never fractional), points sit at column centers so the hover columns, x
 * labels and lines always align. A REAL tooltip card (hover on desktop, tap on
 * touch — native title tooltips never show on phones) gives the exact count of
 * every series for the selected day, with a vertical guide line and a marker
 * dot on each line so it's obvious which day is being read.
 * `labels="month"` renders month names (long custom ranges, month-bucketed).
 */
export function MultiLineSeries({
  dates,
  series,
  labels = "day",
  showValues = false,
}: {
  dates: string[];
  series: LineDef[];
  labels?: "day" | "month";
  /** Per-point count row above the plot — for single-line charts. */
  showValues?: boolean;
}) {
  const [hoverRaw, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  // The hit-layer rect is CACHED per gesture: reading getBoundingClientRect on
  // every pointermove right after setHover's style commit forces a synchronous
  // reflow per event for the whole scrub. One read at gesture start, then pure
  // arithmetic; invalidated on resize/scroll (the layout may have shifted).
  const rectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    const drop = () => {
      rectRef.current = null;
    };
    window.addEventListener("resize", drop);
    window.addEventListener("scroll", drop, { passive: true, capture: true });
    return () => {
      window.removeEventListener("resize", drop);
      window.removeEventListener("scroll", drop, { capture: true } as EventListenerOptions);
    };
  }, []);
  // On touch the selection is STICKY: lifting the finger must not hide the
  // tooltip (pointerleave fires on touch end). It clears on a tap anywhere
  // outside the plot instead.
  useEffect(() => {
    if (hoverRaw == null) return;
    const onDocDown = (e: PointerEvent) => {
      if (plotRef.current && !plotRef.current.contains(e.target as Node)) setHover(null);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [hoverRaw]);
  const n = dates.length;
  // Clamp against SHRINKING data: a sticky (touch) selection survives a range
  // change or background revalidation — an out-of-bounds index must never
  // reach dates[hover].split(...) and crash the chart.
  const hover = hoverRaw != null && hoverRaw < n ? hoverRaw : null;
  const monthly = labels === "month";
  const fullDay = (s: string) =>
    monthly ? fmtUtc(s, { key: "MY", month: "long", year: "numeric" }) : fmtUtc(s, { key: "wdm", weekday: "short", day: "numeric", month: "short" });
  const monthDay = (s: string) =>
    monthly ? fmtUtc(s, { key: "my", month: "short", year: "numeric" }) : fmtUtc(s, { key: "md", month: "short", day: "numeric" });
  const shortMonth = (s: string) => fmtUtc(s, { key: "m", month: "short" });
  if (n === 0 || series.length === 0) return <ChartEmpty />;

  // Integer axis: 4 equal whole-count steps that always contain the max.
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * 4;

  // Column-centered x (like a category axis): point i at x = i + 0.5 of n.
  const x = (i: number) => i + 0.5;
  const y = (v: number) => top - v;
  const pts = (vals: number[]) => vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");

  // Crowded axes stay readable: label every k-th column, the tooltip stays exact.
  const k = Math.ceil(n / 16);
  const single = series.length === 1;
  // % positions for the HTML overlays (guide line, marker dots, tooltip).
  const colPct = (i: number) => ((i + 0.5) / n) * 100;
  const valPct = (v: number) => (1 - v / top) * 100;
  const hoverTotal = hover != null ? series.reduce((a, s) => a + (s.values[hover] || 0), 0) : 0;

  return (
    <div>
      {showValues && single && (
        // pl-9 = y-axis width (w-7) + gap-2, so the counts sit over their columns.
        <div className="mb-1 flex pl-9">
          {series[0].values.map((v, i) => (
            <span key={dates[i]} className="flex-1 text-center text-[10px] font-semibold leading-none tabular-nums text-ink">
              {v > 0 ? v : ""}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {/* y-axis: exact whole-count tick labels, top to bottom. */}
        <div className="relative w-7 shrink-0 text-right">
          {[4, 3, 2, 1, 0].map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[10px] leading-none tabular-nums text-ink-subtle"
              style={{ top: `${((4 - t) / 4) * 100}%` }}
            >
              {t * step}
            </span>
          ))}
        </div>

        <div
          className="relative h-40 min-w-0 flex-1 sm:h-48"
          // Mouse only: touch fires pointerleave the moment the finger lifts,
          // which would hide the tooltip right as the user tries to read it.
          onPointerLeave={(e) => {
            // The gesture is over — next one re-measures (layout can shift
            // without a resize/scroll event: a scrollbar appearing, a modal's
            // body lock, async content above).
            rectRef.current = null;
            if (e.pointerType === "mouse") setHover(null);
          }}
          onPointerUp={() => {
            rectRef.current = null;
          }}
        >
          {/* gridlines at every tick */}
          {[0, 1, 2, 3, 4].map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-line/60" style={{ top: `${(t / 4) * 100}%` }} />
          ))}
          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${n} ${top}`} preserveAspectRatio="none" aria-hidden>
            {/* Single-series (Review volume): soft area fill under the line so
                the shape reads at a glance even on small screens. */}
            {single && (
              <polygon
                points={`${x(0)},${y(0)} ${pts(series[0].values)} ${x(n - 1)},${y(0)}`}
                fill={series[0].color}
                opacity={0.12}
              />
            )}
            {series.map((s) => (
              <polyline
                key={s.label}
                points={pts(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>

          {/* A 1-day range (Today/Yesterday presets) has no second point — a
              single-point polyline draws NOTHING, leaving the plot blank with
              data present. Render one fixed dot per series instead. HTML
              overlay like the hover markers, not an SVG <circle>: the
              non-uniform viewBox scale would stretch a circle into an
              ellipse. */}
          {n === 1 &&
            series.map((s) => (
              <span
                key={s.label}
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-xs"
                style={{ left: `${colPct(0)}%`, top: `${valPct(s.values[0] || 0)}%`, background: s.color }}
              />
            ))}

          {/* Selected day: vertical guide + one marker dot per line. */}
          {hover != null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-ink/25"
                style={{ left: `${colPct(hover)}%` }}
              />
              {series.map((s) => (
                <span
                  key={s.label}
                  className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-xs"
                  style={{ left: `${colPct(hover)}%`, top: `${valPct(s.values[hover] || 0)}%`, background: s.color }}
                />
              ))}
            </>
          )}

          {/* Hit layer: ONE surface that maps any pointer x to its day — hover
              on desktop, tap AND touch-drag scrubbing on mobile. touch-pan-y
              keeps vertical page scroll working while horizontal drags scrub. */}
          <div
            ref={plotRef}
            className="absolute inset-0 flex touch-pan-y"
            onPointerDown={(e) => {
              const r = (rectRef.current ??= e.currentTarget.getBoundingClientRect());
              setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
            }}
            onPointerMove={(e) => {
              const r = (rectRef.current ??= e.currentTarget.getBoundingClientRect());
              setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
            }}
          >
            {dates.map((d, i) => (
              <div key={d} className={cn("pointer-events-none min-w-0 flex-1", hover === i && "bg-ink/[0.04]")} />
            ))}
          </div>

          {/* Tooltip card: exact counts for every series on the selected day.
              Floats ABOVE the plot (never under the finger on touch), anchored
              to the column and clamped by thirds so it can't clip at an edge. */}
          {hover != null && (
            <div
              // Opaque, no backdrop-blur: the card moves every frame while
              // scrubbing, and re-blurring under it visibly stutters on phones.
              className="pointer-events-none absolute z-10 min-w-[7.5rem] rounded-lg border border-line/80 bg-surface px-2.5 py-2 shadow-pop ring-1 ring-ink/5"
              style={{
                bottom: "calc(100% + 6px)",
                ...(hover < n / 3
                  ? { left: `${colPct(hover)}%` }
                  : hover > (2 * n) / 3
                  ? { right: `${100 - colPct(hover)}%` }
                  : { left: `${colPct(hover)}%`, transform: "translateX(-50%)" }),
              }}
            >
              <div className="mb-1 text-[11px] font-semibold text-ink">{fullDay(dates[hover])}</div>
              <div className="flex flex-col gap-0.5">
                {series.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5 text-[11px] leading-tight">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="text-ink-muted">{s.label}</span>
                    <span className={cn("ml-auto pl-3 tabular-nums", (s.values[hover] || 0) > 0 ? "font-semibold text-ink" : "text-ink-subtle")}>
                      {s.values[hover] || 0}
                    </span>
                  </div>
                ))}
                {!single && (
                  <div className="mt-1 flex items-center gap-1.5 border-t border-line/70 pt-1 text-[11px] leading-tight">
                    <span className="text-ink-muted">Total</span>
                    <span className="ml-auto pl-3 font-semibold tabular-nums text-ink">{hoverTotal}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex pl-9">
        {dates.map((d, i) => (
          <span key={d} className="min-w-0 flex-1 text-center text-[10px] leading-none tabular-nums text-ink-subtle">
            {i % k === 0 ? (monthly ? shortMonth(d) : Number(d.slice(8, 10))) : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-ink-subtle">
        <span>{monthDay(dates[0])} – {monthDay(dates[n - 1])}</span>
        <span className="hidden text-ink-subtle/70 sm:inline">· hover a day for exact counts</span>
        <span className="text-ink-subtle/70 sm:hidden">· tap or slide across days for exact counts</span>
      </div>
    </div>
  );
}

/** Horizontal bars for top languages / lists. */
export function HBars({
  data,
  color = "#3b82f6",
  format,
  valueClassName = "",
  labelClassName = "w-20 sm:w-24",
  stackOnMobile = false,
}: {
  /** `label` renders as-is — pass a friendly name, not a raw code, since mobile
   * has no hover; `title` adds the tooltip detail (e.g. "Hindi (hi)"). Pass
   * `key` (the raw code) when labels can collide — e.g. `pt` and `pt-BR` both
   * display as "Portuguese", which would duplicate React keys. */
  data: { key?: string; label: string; value: number; title?: string }[];
  color?: string;
  /** Render the trailing figure as something other than the raw number — e.g.
   * a duration ("12 hours 4 minutes"). Bar LENGTHS always use the raw value, so
   * the geometry stays honest whatever the label says. */
  format?: (value: number) => string;
  /** Widen the value column when the formatted text is longer than a count. */
  valueClassName?: string;
  /** Widen the label column for long names. The default suits short labels
   * (language names); app names need considerably more before truncating. */
  labelClassName?: string;
  /**
   * Phone layout: put the label and value on their own line with the bar
   * beneath, instead of squeezing all three across ~350px. A fixed label column
   * on a phone leaves maybe 90px for the name, which turns every real app name
   * into an ellipsis — the one thing the reader needs in order to know which
   * bar they're looking at. Desktop is unchanged (label · bar · value in a row).
   *
   * One DOM structure for both, ordered with flex-wrap: the bar takes w-full so
   * it wraps to its own line, and `order-last` puts it after the value there —
   * `sm:` restores document order. No duplicated markup, nothing hidden.
   */
  stackOnMobile?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className={stackOnMobile ? "flex flex-col gap-3.5 sm:gap-2.5" : "flex flex-col gap-2.5"}>
      {data.map((d) => (
        <li
          key={d.key ?? d.label}
          className={cn("text-sm", stackOnMobile ? "flex flex-wrap items-center gap-x-3 gap-y-1.5" : "flex items-center gap-3")}
        >
          <span
            title={d.title || d.label}
            className={cn("truncate text-ink-muted", stackOnMobile ? "min-w-0 flex-1 sm:flex-none" : "shrink-0", labelClassName)}
          >
            {d.label}
          </span>
          <div
            className={cn(
              "h-2.5 overflow-hidden rounded-full bg-canvas",
              stackOnMobile ? "order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1" : "min-w-0 flex-1"
            )}
          >
            <div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: color }} />
          </div>
          <span className={cn("shrink-0 text-right font-medium tabular-nums text-ink", valueClassName)}>
            {format ? format(d.value) : d.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ChartEmpty({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-40 items-center justify-center text-sm text-ink-subtle", className)}>
      No data yet
    </div>
  );
}
