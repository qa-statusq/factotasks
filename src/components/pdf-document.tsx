"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { IconZoomIn, IconZoomOut } from "@/components/ui/icons";

/**
 * A PDF drawn by PDF.js (Mozilla's renderer) — the same on every device: a
 * computer, Android and an iPhone, where browsers can't show a PDF inside a
 * page at all. Word, Excel and PowerPoint files come here as their PDF preview.
 *
 *   - Pages in a scrolling column; only those near the screen are drawn, at
 *     the screen's real pixel density, so long documents stay light and sharp.
 *   - Zoom: − / % / + / Fit, Ctrl (⌘) + scroll or a trackpad pinch around the
 *     pointer, two-finger pinch on a phone around the fingers. A plain scroll
 *     or one finger moves through the pages. 50% to 400% of "fit width".
 */
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type Doc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

const MIN = 0.5;
const MAX = 4;
const GAP = 12; // px between pages
const PAD = 16; // px around the column

export function PdfDocument({ data, name }: { data: Blob; name: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let task: ReturnType<PdfJs["getDocument"]> | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const bytes = new Uint8Array(await data.arrayBuffer());
        task = pdfjs.getDocument({ data: bytes, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
        const loaded = await task.promise;
        // Every page's size at 100% (points) — the column's layout before anything is drawn.
        const all: { w: number; h: number }[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const p = await loaded.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          all.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setSizes(all);
        setDoc(loaded);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [data]);

  if (failed) return <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-white/70">Couldn&rsquo;t show {name}. Download it to open it on your device.</div>;
  if (!doc || !sizes.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12.5px] text-white/70">
        <Spinner />
        Opening {name}
      </div>
    );
  return <Pages doc={doc} sizes={sizes} />;
}

function Pages({ doc, sizes }: { doc: Doc; sizes: { w: number; h: number }[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0); // the scroll box's width
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  // Where a zoom should keep its anchor: content point (unscaled) under a box point.
  const anchor = useRef<{ cx: number; cy: number; bx: number; by: number } | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => setWidth(box.clientWidth));
    ro.observe(box);
    setWidth(box.clientWidth);
    return () => ro.disconnect();
  }, []);

  // "Fit width": the widest page across the box (never wider than a comfortable reading width).
  const widest = Math.max(...sizes.map((s) => s.w));
  const fit = width ? Math.min(width - PAD * 2, 1100) / widest : 1;
  const scale = fit * zoom;

  /** Zoom to z keeping the content under (bx, by) — box coordinates — where it is. */
  const zoomAround = (z: number, bx: number, by: number) => {
    const box = boxRef.current;
    const next = Math.min(MAX, Math.max(MIN, z));
    if (!box || next === zoomRef.current) return;
    const s = fit * zoomRef.current;
    anchor.current = { cx: (box.scrollLeft + bx - PAD) / s, cy: (box.scrollTop + by - PAD) / s, bx, by };
    zoomRef.current = next;
    setZoom(next);
  };
  // After the column has its new size, scroll so the anchor stays put.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const a = anchor.current;
    if (!box || !a) return;
    anchor.current = null;
    box.scrollLeft = a.cx * scale + PAD - a.bx;
    box.scrollTop = a.cy * scale + PAD - a.by;
  }, [scale]);

  // Ctrl / ⌘ + wheel and a trackpad pinch zoom; a plain wheel scrolls the pages.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAround(zoomRef.current * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    };
    // Two fingers pinch; one finger scrolls as usual (the browser does that).
    let pinch: { d: number; z: number } | null = null;
    const pts = (e: TouchEvent) => [e.touches[0], e.touches[1]];
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = pts(e);
        pinch = { d: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY), z: zoomRef.current };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); // no page zoom, no scroll while pinching
      const [a, b] = pts(e);
      const r = box.getBoundingClientRect();
      const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      zoomAround(pinch.z * (d / pinch.d), (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd);
    box.addEventListener("touchcancel", onEnd);
    return () => {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAround reads refs and `fit`, re-bound below when fit changes
  }, [fit]);

  // Which page is in view (for the "3 / 12" counter).
  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    let y = PAD;
    const mid = box.scrollTop + box.clientHeight / 3;
    for (let i = 0; i < sizes.length; i++) {
      y += sizes[i].h * scale + GAP;
      if (y > mid) {
        if (page !== i + 1) setPage(i + 1);
        return;
      }
    }
  };

  const btn = "flex h-8 min-w-8 items-center justify-center rounded-lg px-1.5 text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40";
  const centre = () => {
    const box = boxRef.current;
    return box ? { x: box.clientWidth / 2, y: box.clientHeight / 2 } : { x: 0, y: 0 };
  };
  return (
    <div className="relative h-full">
      <div ref={boxRef} onScroll={onScroll} className="h-full overflow-auto overscroll-contain [touch-action:pan-x_pan-y]" data-pdf-scroll>
        <div className="mx-auto flex w-max min-w-full flex-col items-center" style={{ padding: PAD, gap: GAP }}>
          {width > 0 && sizes.map((s, i) => <PageCanvas key={i} doc={doc} index={i + 1} w={s.w * scale} h={s.h * scale} scale={scale} root={boxRef} />)}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center pb-[env(safe-area-inset-bottom)]">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl bg-black/75 p-1 text-white shadow-lg ring-1 ring-white/10 backdrop-blur">
          <span className="px-2 text-[12px] tabular-nums text-white/70">
            Page {page} / {sizes.length}
          </span>
          <span className="mx-0.5 h-5 w-px bg-white/15" />
          <button type="button" className={btn} onClick={() => zoomAround(zoomRef.current / 1.25, centre().x, centre().y)} disabled={zoom <= MIN} aria-label="Zoom out">
            <IconZoomOut size={16} />
          </button>
          <button type="button" className={cn(btn, "w-14 text-[12px] font-semibold tabular-nums")} onClick={() => zoomAround(1, centre().x, centre().y)} title="Fit width">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className={btn} onClick={() => zoomAround(zoomRef.current * 1.25, centre().x, centre().y)} disabled={zoom >= MAX} aria-label="Zoom in">
            <IconZoomIn size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** One page: drawn when it comes near the screen (and again, sharp, after a zoom settles); dropped when far away. */
function PageCanvas({ doc, index, w, h, scale, root }: { doc: Doc; index: number; w: number; h: number; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setNear(es[0].isIntersecting), { root: root.current, rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!near) {
      // Far away: give the memory back.
      c.width = 0;
      c.height = 0;
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    // Wait for a zoom gesture to settle before redrawing (the old drawing stretches meanwhile).
    const t = window.setTimeout(async () => {
      try {
        const p = await doc.getPage(index);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        // Keep a page under ~16 million pixels (mobile canvas limits), whatever the zoom.
        const k = Math.min(dpr, Math.sqrt(16_000_000 / Math.max(1, w * h)));
        const vp = p.getViewport({ scale: scale * k });
        const off = document.createElement("canvas");
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        task = p.render({ canvas: off, viewport: vp }) as unknown as { cancel: () => void; promise: Promise<unknown> };
        await task.promise;
        if (cancelled) return;
        c.width = off.width;
        c.height = off.height;
        c.getContext("2d")?.drawImage(off, 0, 0);
      } catch {
        /* cancelled or failed: the page stays as it was */
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      task?.cancel();
    };
  }, [near, scale, doc, index, w, h]);
  return (
    <div ref={holder} className="relative shrink-0 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.35)]" style={{ width: w, height: h }}>
      <canvas ref={canvas} className="block h-full w-full" aria-label={`Page ${index}`} />
    </div>
  );
}
