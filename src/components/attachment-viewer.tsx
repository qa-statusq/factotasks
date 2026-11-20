"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "@/components/ui/misc";
import { DownloadButton } from "@/components/ui/download-button";
import { useModalChrome } from "@/components/ui/use-modal-chrome";
import { ZoomableImage, type ZoomHandle } from "@/components/zoom-image";
import { PdfDocument } from "@/components/pdf-document";
import { fmtBytes } from "@/lib/format";
import { cachedFile, loadFile, preloadFile, releaseFile } from "@/lib/file-cache";
import { parseCsv, parseXlsx, type Sheet } from "@/lib/spreadsheet";
import { SheetView } from "@/components/sheet-view";
import { useLatest } from "@/lib/use-latest";
import { cn } from "@/lib/cn";
import { IconFile, IconImage, IconMic, IconChevronLeft, IconChevronRight, IconX, IconZoomIn, IconZoomOut, IconMaximize, IconMinimize } from "@/components/ui/icons";
import type { TaskAttachment } from "@/lib/types";

export type Kind = "image" | "pdf" | "office" | "sheet" | "video" | "audio" | "text" | "other";
/** Spreadsheets shown as a grid in the browser (lib/spreadsheet): Excel 2007+ and CSV / TSV. */
const SHEET = /^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/csv|text\/tab-separated-values)$/;
/** Word, Excel and PowerPoint: shown as the PDF Google makes of them (see lib/doc-preview). */
const OFFICE = /^application\/(vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|msword|vnd\.ms-excel|vnd\.ms-powerpoint)$/;
export function kindOf(mime: string, name: string): Kind {
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (SHEET.test(mime) || (/\.(csv|tsv)$/i.test(name) && mime.startsWith("text/"))) return "sheet";
  if (OFFICE.test(mime)) return "office";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|log|txt|csv|json)$/i.test(name)) return "text";
  return "other";
}
const KIND_LABEL: Record<Kind, string> = { image: "image", pdf: "PDF", office: "document", sheet: "spreadsheet", video: "video", audio: "audio", text: "text", other: "file" };
export function fileLabel(a: TaskAttachment): string {
  const ext = a.file_name.split(".").pop()?.toUpperCase();
  if (/apk|aab|ipa/i.test(ext ?? "")) return `${ext} build`;
  if (/^(xlsx?|csv|tsv)$/i.test(ext ?? "")) return `${ext} spreadsheet`;
  if (/^pptx?$/i.test(ext ?? "")) return `${ext} presentation`;
  if (/^docx?$/i.test(ext ?? "")) return `${ext} document`;
  if (ext === "ZIP") return "archive";
  return KIND_LABEL[kindOf(a.mime, a.file_name)];
}

const subscribeNever = () => () => {};

/* ---------------------------- full screen -------------------------------- */

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void>; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;
const fsSupported = () => typeof document !== "undefined" && !!(document.fullscreenEnabled || (document as FsDoc).webkitFullscreenEnabled);
function enterFs(el: HTMLElement) {
  const e = el as FsEl;
  return (e.requestFullscreen ? e.requestFullscreen() : e.webkitRequestFullscreen?.())?.catch(() => undefined);
}
function exitFs() {
  if (!fsElement()) return;
  const d = document as FsDoc;
  return (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.())?.catch(() => undefined);
}

/**
 * Files, one at a time, in a full-screen viewer (like Google Photos / Drive):
 * pictures zoom (pinch, wheel / trackpad, double-tap, + / − / Fit), PDFs,
 * videos, sound and text show in place, everything else offers a download.
 * Previous / next by the arrows, the ← → keys or a swipe; F or the button
 * fills the whole screen. Used by tasks, meetings and the presentation alike.
 */
export function AttachmentViewer({ items: maybeItems, startId, base, onClose, emptyText = "No files here yet." }: { items: TaskAttachment[] | null; startId?: string; base: string; onClose: () => void; emptyText?: string }) {
  const items = useMemo(() => maybeItems ?? [], [maybeItems]);
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((x) => x.id === startId)));
  const a = items[Math.min(idx, Math.max(0, items.length - 1))];
  const many = items.length > 1;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomHandle | null>(null);
  const [zoom, setZoom] = useState<{ scale: number; atFit: boolean }>({ scale: 1, atFit: true });
  const [full, setFull] = useState(false);
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const close = () => {
    void exitFs();
    onClose();
  };
  useModalChrome(close, rootRef);

  // The files either side come down in the background (into the same cache the viewer reads),
  // so stepping to them is instant — pictures two ahead too; a document's preview one either side.
  useEffect(() => {
    if (!many) return;
    for (const d of [1, -1, 2]) {
      const n = items[(idx + d + items.length) % items.length];
      if (!n || n.id === items[idx]?.id) continue;
      const k = kindOf(n.mime, n.file_name);
      if (d === 2 && k !== "image") continue;
      if (k === "image" || k === "pdf" || k === "sheet") preloadFile(`${base}/${n.id}`, n.size_bytes);
      else if (k === "office") preloadFile(`${base}/${n.id}?preview=1`, 0);
    }
  }, [idx, items, many, base]);
  const step = (d: number) => {
    setIdx((i) => (i + d + items.length) % items.length);
    setZoom({ scale: 1, atFit: true });
  };
  const kind = a ? kindOf(a.mime, a.file_name) : "other";
  const keys = useLatest((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = e.target as HTMLElement | null;
    if (t && t.closest("input, textarea, select, video, audio")) return false;
    if (e.key === "ArrowRight" && many) step(1);
    else if (e.key === "ArrowLeft" && many) step(-1);
    else if ((e.key === "+" || e.key === "=") && kind === "image") zoomRef.current?.zoomBy(1.5);
    else if ((e.key === "-" || e.key === "_") && kind === "image") zoomRef.current?.zoomBy(1 / 1.5);
    else if (e.key === "0" && kind === "image") zoomRef.current?.fit();
    else if (e.key === "f" || e.key === "F") toggleFull();
    else return false;
    return true;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keys.current(e)) {
        e.preventDefault();
        e.stopPropagation(); // a presentation behind turns slides on the arrows
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys]);

  // Full screen: follows the browser (Esc in full screen leaves it, the viewer stays open).
  useEffect(() => {
    const sync = () => setFull(!!fsElement() && fsElement() === rootRef.current);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      void exitFs();
    };
  }, []);
  function toggleFull() {
    if (!rootRef.current || !fsSupported()) return;
    if (fsElement()) void exitFs();
    else void enterFs(rootRef.current);
  }

  // Swipe for the non-picture kinds (a picture handles its own, so a zoomed one can be dragged).
  const touch = useRef<{ x: number; y: number } | null>(null);
  if (!mounted) return null;
  const src = a ? `${base}/${a.id}` : "";
  const btn = "tap flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg px-2 text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40";

  return createPortal(
    <div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={a ? a.file_name : "Files"} data-attachment-viewer className="fixed inset-0 z-[100] flex flex-col bg-[#0b0b0a] text-white outline-none animate-fade-in">
      {/* Top bar: what it is, then zoom, full screen, download, close. */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold" data-nowrap>{a ? a.file_name : "Files"}</p>
          {a && (
            <p className="truncate text-[11.5px] text-white/55" data-nowrap>
              {many ? `${idx + 1} of ${items.length} · ` : ""}
              {fmtBytes(a.size_bytes)}
              {a.width ? ` · ${a.width}×${a.height}` : ""} · {fileLabel(a)}
              {a.uploaded_by ? ` · ${a.uploaded_by.name}` : ""}
            </p>
          )}
        </div>
        {a && kind === "image" && (
          <div className="hidden items-center gap-0.5 rounded-xl bg-white/[0.06] p-0.5 sm:flex">
            <button type="button" className={btn} onClick={() => zoomRef.current?.zoomBy(1 / 1.5)} disabled={zoom.atFit} aria-label="Zoom out" title="Zoom out (−)">
              <IconZoomOut size={17} />
            </button>
            <button type="button" className={cn(btn, "w-14 text-[12px] font-semibold tabular-nums")} onClick={() => zoomRef.current?.toggleActual()} title="Actual size / fit (0 fits)">
              {Math.round(zoom.scale * 100)}%
            </button>
            <button type="button" className={btn} onClick={() => zoomRef.current?.zoomBy(1.5)} disabled={zoom.scale >= 3.99} aria-label="Zoom in" title="Zoom in (+)">
              <IconZoomIn size={17} />
            </button>
            <button type="button" className={cn(btn, "text-[12px] font-semibold")} onClick={() => zoomRef.current?.fit()} disabled={zoom.atFit} title="Fit to screen (0)">
              Fit
            </button>
          </div>
        )}
        {fsSupported() && (
          <button type="button" className={btn} onClick={toggleFull} aria-label={full ? "Leave full screen" : "Full screen"} title={full ? "Leave full screen (F)" : "Full screen (F)"}>
            {full ? <IconMinimize size={17} /> : <IconMaximize size={17} />}
          </button>
        )}
        {a && <DownloadButton url={src} name={a.file_name} size={a.size_bytes} iconOnly plain className="tap h-9 min-w-9 px-2 text-white/85 hover:bg-white/10 hover:text-white" />}
        <button type="button" className={btn} onClick={close} aria-label="Close" title="Close (Esc)">
          <IconX size={19} />
        </button>
      </div>

      {/* The file. */}
      <div
        className="relative min-h-0 flex-1"
        onTouchStart={(e) => {
          e.stopPropagation(); // a presentation behind turns slides on swipe
          if (kind !== "image") touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          const s0 = touch.current;
          touch.current = null;
          if (!s0 || !many || kind === "image") return;
          const dx = e.changedTouches[0].clientX - s0.x;
          const dy = e.changedTouches[0].clientY - s0.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        }}
      >
        {a ? (
          <FileView key={a.id} a={a} src={src} zoomRef={zoomRef} onZoom={(scale, atFit) => setZoom((z) => (Math.abs(z.scale - scale) < 0.005 && z.atFit === atFit ? z : { scale, atFit }))} onSwipe={many ? step : undefined} />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-white/60">{maybeItems ? emptyText : <Spinner />}</div>
        )}
        {many && (
          <>
            <button type="button" onClick={() => step(-1)} className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex" aria-label="Previous file" title="Previous (←)">
              <IconChevronLeft size={22} />
            </button>
            <button type="button" onClick={() => step(1)} className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex" aria-label="Next file" title="Next (→)">
              <IconChevronRight size={22} />
            </button>
          </>
        )}
      </div>

      {many && <Filmstrip items={items} idx={Math.min(idx, items.length - 1)} base={base} onPick={(i) => { setIdx(i); setZoom({ scale: 1, atFit: true }); }} />}

      {/* Phones: previous / next and zoom at the thumb. */}
      {(many || kind === "image") && (
        <div className="flex shrink-0 items-center justify-center gap-2 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:hidden">
          {many && (
            <button type="button" className={btn} onClick={() => step(-1)} aria-label="Previous file">
              <IconChevronLeft size={20} />
            </button>
          )}
          {kind === "image" && (
            <>
              <button type="button" className={btn} onClick={() => zoomRef.current?.zoomBy(1 / 1.5)} disabled={zoom.atFit} aria-label="Zoom out">
                <IconZoomOut size={18} />
              </button>
              <button type="button" className={cn(btn, "w-14 text-[12px] font-semibold tabular-nums")} onClick={() => zoomRef.current?.toggleActual()} aria-label="Actual size or fit">
                {Math.round(zoom.scale * 100)}%
              </button>
              <button type="button" className={btn} onClick={() => zoomRef.current?.zoomBy(1.5)} disabled={zoom.scale >= 3.99} aria-label="Zoom in">
                <IconZoomIn size={18} />
              </button>
            </>
          )}
          {many && (
            <>
              <span className="min-w-[3rem] text-center text-[12px] tabular-nums text-white/60">
                {idx + 1} / {items.length}
              </span>
              <button type="button" className={btn} onClick={() => step(1)} aria-label="Next file">
                <IconChevronRight size={20} />
              </button>
            </>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}

/** One file's body, filling the viewer: a zoomable picture, a PDF, a video or audio clip, a text file, or a download card. */
function FileView({ a, src, zoomRef, onZoom, onSwipe }: { a: TaskAttachment; src: string; zoomRef: React.RefObject<ZoomHandle | null>; onZoom: (scale: number, atFit: boolean) => void; onSwipe?: (d: number) => void }) {
  const kind = kindOf(a.mime, a.file_name);
  return (
    <>
      {kind === "image" && <ImageView src={src} a={a} zoomRef={zoomRef} onZoom={onZoom} onSwipe={onSwipe} />}
      {kind === "pdf" && <PdfView src={src} a={a} />}
      {kind === "office" && <PdfView src={`${src}?preview=1`} a={a} preparing />}
      {kind === "sheet" && <SheetFile src={src} a={a} />}
      {kind === "video" && <VideoView src={src} a={a} />}
      {kind === "audio" && (
        <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-white">
            <IconMic size={28} />
          </span>
          <audio src={src} controls autoPlay preload="metadata" className="w-full max-w-lg" />
        </div>
      )}
      {kind === "text" && <TextView src={src} a={a} />}
      {kind === "other" && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-white/80">
            {/\.(png|jpe?g|webp|gif)$/i.test(a.file_name) ? <IconImage size={28} /> : <IconFile size={28} />}
          </span>
          <p className="max-w-full break-words text-[14px] font-medium">{a.file_name}</p>
          <p className="max-w-sm text-[12.5px] text-white/60">This {fileLabel(a)} can&rsquo;t be shown in the browser. Download it to open it on your device.</p>
          <DownloadButton url={src} name={a.file_name} size={a.size_bytes} plain label={`Download ${fmtBytes(a.size_bytes)}`} className="h-9 bg-white text-[#0b0b0a] hover:bg-white/90 [&_span]:inline" />
        </div>
      )}
    </>
  );
}

/**
 * The file's bytes with live progress — a ring with the percentage while it
 * downloads, then the file. Read through the shared file cache (lib/file-cache):
 * a file seen before (or preloaded as a neighbour) is there at once, the same
 * object URL, nothing downloaded or decoded again. Leaving a big file early
 * cancels its download.
 */
function useFileBytes(src: string, size = 0) {
  const [state, setState] = useState<{ url: string | null; blob: Blob | null; loaded: number; total: number; error: boolean }>(() => {
    const hit = cachedFile(src);
    return hit ? { url: hit.url, blob: hit.blob, loaded: hit.blob.size, total: hit.blob.size, error: false } : { url: null, blob: null, loaded: 0, total: 0, error: false };
  });
  useEffect(() => {
    if (cachedFile(src)) return; // already on screen from the first render
    let alive = true;
    let shown = 0;
    const onProgress = (loaded: number, total: number) => {
      // Repaint the ring at most every ~3%.
      if (alive && (!total || loaded - shown > total / 33 || loaded < shown)) {
        shown = loaded;
        setState((st) => ({ ...st, loaded, total }));
      }
    };
    loadFile(src, size, onProgress).then(
      ({ blob, url }) => alive && setState({ url, blob, loaded: blob.size, total: blob.size, error: false }),
      () => alive && setState((st) => ({ ...st, error: true }))
    );
    return () => {
      alive = false;
      releaseFile(src, onProgress);
    };
  }, [src, size]);
  return state;
}

/** The loading card: a progress ring (or a spinning arc while the size is unknown), the name and the bytes so far. */
function FileLoading({ a, loaded, total }: { a: TaskAttachment; loaded: number; total: number }) {
  const size = total || a.size_bytes;
  const pct = size ? Math.min(100, Math.round((loaded / size) * 100)) : 0;
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center" role="status" aria-live="polite">
      <svg width="56" height="56" viewBox="0 0 56 56" className={loaded ? "-rotate-90" : "animate-spin"} aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="4" stroke="rgba(255,255,255,0.15)" />
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="4" strokeLinecap="round" stroke="white" className="transition-[stroke-dashoffset] duration-200" strokeDasharray={c} strokeDashoffset={loaded ? c * (1 - pct / 100) : c * 0.75} />
      </svg>
      <div>
        <p className="max-w-[min(28rem,80vw)] truncate text-[13px] font-medium" data-nowrap>Loading {a.file_name}</p>
        <p className="mt-0.5 text-[12px] tabular-nums text-white/55">{loaded ? `${pct}% · ${fmtBytes(loaded)} of ${fmtBytes(size)}` : `Preparing ${fmtBytes(size)}…`}</p>
      </div>
    </div>
  );
}

function LoadFailed({ src, a }: { src: string; a: TaskAttachment }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-[13px] text-white/70">Couldn&rsquo;t load {a.file_name}. Check the connection, or download it instead.</p>
      <DownloadButton url={src} name={a.file_name} size={a.size_bytes} plain className="h-9 bg-white/10 text-white hover:bg-white/20 [&_span]:inline" />
    </div>
  );
}

function ImageView({ src, a, zoomRef, onZoom, onSwipe }: { src: string; a: TaskAttachment; zoomRef: React.RefObject<ZoomHandle | null>; onZoom: (scale: number, atFit: boolean) => void; onSwipe?: (d: number) => void }) {
  const f = useFileBytes(src, a.size_bytes);
  if (f.url) return <ZoomableImage src={f.url} alt={a.file_name} handle={zoomRef} onZoom={onZoom} onSwipe={onSwipe} />;
  return f.error ? <LoadFailed src={src} a={a} /> : <FileLoading a={a} loaded={f.loaded} total={f.total} />;
}

function PdfView({ src, a, preparing }: { src: string; a: TaskAttachment; preparing?: boolean }) {
  // A document's preview size isn't known up front (0 = fetch in pieces until the end).
  const f = useFileBytes(src, preparing ? 0 : a.size_bytes);
  // Drawn by PDF.js (lib: components/pdf-document) — works the same on phones, where a browser can't show a PDF in a page.
  if (f.blob) return <PdfDocument data={f.blob} name={a.file_name} />;
  if (f.error) return <LoadFailed src={src.replace(/\?preview=1$/, "")} a={a} />;
  // A document opened for the first time is converted first (a few seconds): say so instead of "Preparing 7 KB".
  return preparing && !f.loaded ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-white/70" role="status">
      <Spinner />
      Preparing a preview of {a.file_name}…
    </div>
  ) : (
    <FileLoading a={a} loaded={f.loaded} total={f.total} />
  );
}

function TextView({ src, a }: { src: string; a: TaskAttachment }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(src, { credentials: "same-origin", headers: { Range: "bytes=0-1999999" } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (alive) setText(t.length > 200_000 || a.size_bytes > 2_000_000 ? `${t.slice(0, 200_000)}\n… (only the start is shown — download for the full file)` : t);
      })
      .catch(() => {
        if (alive) setText("Couldn't load the file.");
      });
    return () => {
      alive = false;
    };
  }, [src, a.size_bytes]);
  return text === null ? (
    <div className="flex h-full items-center justify-center"><Spinner /></div>
  ) : (
    <div className="h-full overflow-auto px-3 pb-4 sm:px-6">
      <pre className="mx-auto max-w-5xl whitespace-pre-wrap break-words rounded-lg bg-white/[0.06] p-4 font-mono text-[12.5px] leading-relaxed text-white/90 ring-1 ring-white/10">{text}</pre>
    </div>
  );
}

/** Parsed spreadsheets by address, so going back to one shows it at once. */
const parsedSheets = new Map<string, Sheet[]>();

/** A spreadsheet (xlsx / csv) as a grid with sheet tabs; anything it can't read falls back to the document preview. */
function SheetFile({ src, a }: { src: string; a: TaskAttachment }) {
  const f = useFileBytes(src, a.size_bytes);
  const [sheets, setSheets] = useState<Sheet[] | null>(() => parsedSheets.get(src) ?? null);
  const [bad, setBad] = useState(false);
  const blob = f.blob;
  useEffect(() => {
    if (!blob || parsedSheets.has(src)) return;
    let alive = true;
    (async () => {
      try {
        const csv = /csv|tab-separated/.test(a.mime) || /\.(csv|tsv)$/i.test(a.file_name);
        const out = csv ? [parseCsv(await blob.text())] : parseXlsx(new Uint8Array(await blob.arrayBuffer()));
        parsedSheets.set(src, out);
        if (alive) setSheets(out);
      } catch {
        if (alive) setBad(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [blob, src, a.mime, a.file_name]);
  if (sheets) return <SheetView sheets={sheets} />;
  if (bad) return /csv|tab-separated/.test(a.mime) ? <TextView src={src} a={a} /> : <PdfView src={`${src}?preview=1`} a={a} preparing />;
  if (f.error) return <LoadFailed src={src} a={a} />;
  return f.blob ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[12.5px] text-white/70">
      <Spinner />
      Opening {a.file_name}
    </div>
  ) : (
    <FileLoading a={a} loaded={f.loaded} total={f.total} />
  );
}

/** Colour and label of a file kind, for the film strip's tiles. */
function tileOf(a: TaskAttachment): { label: string; cls: string } {
  const ext = (a.file_name.split(".").pop() || "").toUpperCase().slice(0, 4);
  const k = kindOf(a.mime, a.file_name);
  if (k === "pdf") return { label: "PDF", cls: "bg-[#c62f2f]" };
  if (k === "sheet" || /^XLS/.test(ext)) return { label: ext || "XLS", cls: "bg-[#13774a]" };
  if (/^DOC/.test(ext)) return { label: ext, cls: "bg-[#2b5cb8]" };
  if (/^PPT/.test(ext)) return { label: ext, cls: "bg-[#c8552b]" };
  if (k === "video") return { label: ext || "VIDEO", cls: "bg-[#6b3fb8]" };
  if (k === "audio") return { label: ext || "AUDIO", cls: "bg-[#b8327a]" };
  if (k === "text") return { label: ext || "TXT", cls: "bg-[#4b5563]" };
  return { label: ext || "FILE", cls: "bg-[#3f3f3c]" };
}

/**
 * Every file of the set as a row of thumbnails under the viewer: pictures as
 * themselves (the same request as the card's thumbnail — already cached),
 * other files as a coloured tile with their type. The current one is ringed
 * and kept in view; a tap or click goes straight to that file.
 */
function Filmstrip({ items, idx, base, onPick }: { items: TaskAttachment[]; idx: number; base: string; onPick: (i: number) => void }) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-strip-index="${idx}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [idx]);
  return (
    <div className="flex shrink-0 justify-center px-2 pt-2 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div ref={stripRef} role="tablist" aria-label="Files" className="no-scrollbar flex max-w-full gap-1.5 overflow-x-auto px-1 py-1 [scroll-snap-type:x_proximity]">
        {items.map((it, i) => {
          const on = i === idx;
          const pic = kindOf(it.mime, it.file_name) === "image";
          const t = tileOf(it);
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={`${i + 1}: ${it.file_name}`}
              title={`${i + 1} · ${it.file_name}`}
              data-strip-index={i}
              onClick={() => onPick(i)}
              className={cn("relative h-11 w-11 shrink-0 overflow-hidden rounded-lg transition-[opacity,box-shadow] [scroll-snap-align:center] sm:h-14 sm:w-14", on ? "opacity-100 ring-2 ring-white ring-offset-2 ring-offset-[#0b0b0a]" : "opacity-55 ring-1 ring-white/15 hover:opacity-90")}
            >
              {pic ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${base}/${it.id}`} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
              ) : (
                <span className={cn("flex h-full w-full items-center justify-center text-[10px] font-bold tracking-wide text-white", t.cls)}>{t.label}</span>
              )}
              <span className="absolute bottom-0 right-0 rounded-tl-md bg-black/65 px-1 text-[9.5px] font-semibold tabular-nums leading-[14px] text-white/90">{i + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Video streams as it plays (seeking works, the player has its own full screen), so a spinner until it can start. */
function VideoView({ src, a }: { src: string; a: TaskAttachment }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="relative flex h-full items-center justify-center px-0 pb-0 sm:px-4 sm:pb-4">
      {!ready && (
        <div className="absolute inset-0 z-[1] flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-[12.5px] text-white/70">
            <Spinner />
            Loading {a.file_name}
          </div>
        </div>
      )}
      <video src={src} controls autoPlay playsInline preload="metadata" onCanPlay={() => setReady(true)} onError={() => setReady(true)} className="max-h-full max-w-full bg-black sm:rounded-lg" />
    </div>
  );
}
