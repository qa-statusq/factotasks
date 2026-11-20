"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { IconZoomIn, IconZoomOut } from "@/components/ui/icons";
import { MAX_COLS, MAX_ROWS, type Sheet } from "@/lib/spreadsheet";

/**
 * A spreadsheet the way Excel shows it: column letters, row numbers, the
 * header row and number column pinned while scrolling, numbers right-aligned,
 * sheet tabs along the bottom. Only the rows on screen exist in the page (a
 * 20,000-row export scrolls as smoothly as a 20-row one). Zoom with − / + or
 * Ctrl (⌘) + scroll / a trackpad pinch / two fingers on a phone.
 */
const BASE_ROW = 26; // px at 100%
const BASE_COL = 104; // px for a column without a width
const NUM_COL = 46; // px of the row-number column at 100%
const OVERSCAN = 8;

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function SheetView({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const rowH = Math.round(BASE_ROW * zoom);
  const numW = Math.round(NUM_COL * zoom);
  // Excel widths are in characters of the default font (~7 px each, plus padding).
  const widths = useMemo(() => Array.from({ length: Math.max(1, sheet.cols) }, (_, i) => Math.round((sheet.widths[i] ? Math.min(80, sheet.widths[i]) * 7 + 10 : BASE_COL) * zoom)), [sheet, zoom]);
  const template = `${numW}px ${widths.map((w) => `${w}px`).join(" ")}`;
  const totalRows = Math.max(sheet.rows.length, 1);

  // Back to the top-left when the sheet changes.
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      box.scrollTop = 0;
      box.scrollLeft = 0;
    }
  }, [active]);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const sync = () => setView({ top: box.scrollTop, height: box.clientHeight });
    const ro = new ResizeObserver(sync);
    ro.observe(box);
    sync();
    return () => ro.disconnect();
  }, []);

  const zoomTo = (z: number) => {
    const next = Math.min(2.5, Math.max(0.5, z));
    zoomRef.current = next;
    setZoom(next);
  };
  // Ctrl / ⌘ + wheel and trackpad pinch zoom; two fingers pinch on touch; plain scrolling scrolls.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
    };
    let pinch: { d: number; z: number } | null = null;
    const dist = (e: TouchEvent) => Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { d: dist(e), z: zoomRef.current };
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      zoomTo(pinch.z * (dist(e) / pinch.d));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd);
    return () => {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
    };
  }, []);

  // The rows on screen (plus a few either side); the rest is two spacers.
  const from = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const to = Math.min(totalRows, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  const fontPx = Math.max(9, Math.round(12.5 * zoom));
  const cell = "overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[#e3e3e0] px-2";
  const btn = "flex h-8 min-w-8 items-center justify-center rounded-lg px-1.5 text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40";

  return (
    <div className="flex h-full flex-col px-0 pb-0 sm:px-4 sm:pb-3">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white text-[#1c1c1a] sm:rounded-t-lg">
        <div ref={boxRef} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} className="h-full overflow-auto overscroll-contain [touch-action:pan-x_pan-y]" style={{ fontSize: fontPx }} data-sheet-scroll>
          <div style={{ width: numW + widths.reduce((a, b) => a + b, 0) }}>
            {/* Column letters, pinned to the top. */}
            <div className="sticky top-0 z-[2] grid bg-[#f3f3f1] font-semibold text-[#6b6b66]" style={{ gridTemplateColumns: template, height: rowH }}>
              <div className={cn(cell, "sticky left-0 z-[1] bg-[#ebebe8]")} style={{ lineHeight: `${rowH}px` }} />
              {widths.map((_, i) => (
                <div key={i} className={cn(cell, "text-center")} style={{ lineHeight: `${rowH}px` }}>
                  {colName(i)}
                </div>
              ))}
            </div>
            <div style={{ height: from * rowH }} />
            {Array.from({ length: to - from }, (_, k) => {
              const r = from + k;
              const row = sheet.rows[r] ?? [];
              // Like Excel: text wider than its column runs on over the EMPTY cells to its right
              // (one cell spanning them); numbers never spill.
              const cells: React.ReactNode[] = [];
              for (let c = 0; c < widths.length; c++) {
                const v = row[c] ?? "";
                const num = sheet.numeric.has(`${r}:${c}`);
                let span = 1;
                if (v && !num) {
                  const need = v.length * fontPx * 0.58 + 16;
                  let w = widths[c];
                  while (w < need && c + span < widths.length && !row[c + span]) w += widths[c + span++];
                }
                cells.push(
                  <div key={c} className={cn(cell, num && "text-right tabular-nums")} style={{ lineHeight: `${rowH}px`, gridColumn: span > 1 ? `span ${span}` : undefined }} title={v.length > 14 ? v : undefined}>
                    {v}
                  </div>
                );
                c += span - 1;
              }
              return (
                <div key={r} className="grid" style={{ gridTemplateColumns: template, height: rowH }}>
                  <div className={cn(cell, "sticky left-0 z-[1] bg-[#f3f3f1] text-center font-medium tabular-nums text-[#6b6b66]")} style={{ lineHeight: `${rowH}px` }}>
                    {r + 1}
                  </div>
                  {cells}
                </div>
              );
            })}
            <div style={{ height: Math.max(0, totalRows - to) * rowH }} />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl bg-black/75 p-1 text-white shadow-lg ring-1 ring-white/10 backdrop-blur">
            <span className="px-2 text-[12px] tabular-nums text-white/70">
              {sheet.rows.length.toLocaleString("en-IN")} row{sheet.rows.length === 1 ? "" : "s"}
            </span>
            <span className="mx-0.5 h-5 w-px bg-white/15" />
            <button type="button" className={btn} onClick={() => zoomTo(zoom / 1.2)} disabled={zoom <= 0.5} aria-label="Zoom out">
              <IconZoomOut size={16} />
            </button>
            <button type="button" className={cn(btn, "w-14 text-[12px] font-semibold tabular-nums")} onClick={() => zoomTo(1)} title="Back to 100%">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className={btn} onClick={() => zoomTo(zoom * 1.2)} disabled={zoom >= 2.5} aria-label="Zoom in">
              <IconZoomIn size={16} />
            </button>
          </div>
        </div>
      </div>
      {/* Sheet tabs, like Excel's. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto bg-[#f3f3f1] px-2 py-1.5 sm:rounded-b-lg" role="tablist" aria-label="Sheets">
        {sheets.map((s, i) => (
          <button key={s.name + i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)} className={cn("shrink-0 rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors", i === active ? "bg-white text-[#0f7b45] shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-[#d7d7d3]" : "text-[#55554f] hover:bg-white/70")}>
            {s.name}
          </button>
        ))}
        {sheet.truncated && <span className="ml-auto shrink-0 pl-3 text-[11.5px] text-[#8a6d00]">Showing the first {MAX_ROWS.toLocaleString("en-IN")} rows × {MAX_COLS} columns — download for the rest</span>}
      </div>
    </div>
  );
}
