"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/misc";
import { fmtBytes } from "@/lib/format";
import { useLatest } from "@/lib/use-latest";
import { IconFile, IconDownload, IconImage, IconMic, IconChevronLeft, IconChevronRight } from "@/components/ui/icons";
import type { TaskAttachment } from "@/lib/types";

export type Kind = "image" | "pdf" | "video" | "audio" | "text" | "other";
export function kindOf(mime: string, name: string): Kind {
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|log|txt|csv|json)$/i.test(name)) return "text";
  return "other";
}
const KIND_LABEL: Record<Kind, string> = { image: "image", pdf: "PDF", video: "video", audio: "audio", text: "text", other: "file" };
export function fileLabel(a: TaskAttachment): string {
  const ext = a.file_name.split(".").pop()?.toUpperCase();
  if (/apk|aab|ipa/i.test(ext ?? "")) return `${ext} build`;
  if (/docx?|xlsx?|pptx?/i.test(ext ?? "")) return `${ext} document`;
  if (ext === "ZIP") return "archive";
  return KIND_LABEL[kindOf(a.mime, a.file_name)];
}


/**
 * A task's attachments, one at a time, with previous / next when there is more
 * than one: the buttons, the ← → keys, or a swipe on a phone. Used by the task
 * page and the meeting presentation alike.
 */
export function AttachmentViewer({ items: maybeItems, startId, base, onClose }: { items: TaskAttachment[] | null; startId?: string; base: string; onClose: () => void }) {
  const items = useMemo(() => maybeItems ?? [], [maybeItems]);
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((x) => x.id === startId)));
  const a = items[Math.min(idx, items.length - 1)];
  const many = items.length > 1;

  // Next and previous pictures load in the background, so stepping to them is instant.
  useEffect(() => {
    if (!many) return;
    for (const d of [1, -1]) {
      const n = items[(idx + d + items.length) % items.length];
      if (n && kindOf(n.mime, n.file_name) === "image") {
        const img = new Image();
        img.src = `${base}/${n.id}`;
      }
    }
  }, [idx, items, many, base]);
  const step = (d: number) => setIdx((i) => (i + d + items.length) % items.length);
  const stepRef = useLatest(step);

  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, select, video, audio")) return;
      if (e.key === "ArrowRight") stepRef.current(1);
      else if (e.key === "ArrowLeft") stepRef.current(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [many, stepRef]);

  // Swipe left / right on a phone.
  const touch = useRef<{ x: number; y: number } | null>(null);
  if (!a)
    return (
      <Sheet title={maybeItems ? "No attachments" : "Attachments"} description={maybeItems ? undefined : "Loading…"} onClose={onClose} wide footer={<div className="flex justify-end"><Button size="sm" onClick={onClose}>Close</Button></div>}>
        <div data-attachment-viewer className="flex h-[50vh] items-center justify-center">{maybeItems ? <p className="text-[13px] text-ink-subtle">This task has no attachments.</p> : <Spinner />}</div>
      </Sheet>
    );
  const kind = kindOf(a.mime, a.file_name);
  const src = `${base}/${a.id}`;

  return (
    <Sheet
      title={a.file_name}
      description={`${many ? `${idx + 1} of ${items.length} · ` : ""}${fmtBytes(a.size_bytes)}${a.width ? ` · ${a.width}×${a.height}` : ""} · ${fileLabel(a)}${a.uploaded_by ? ` · ${a.uploaded_by.name}` : ""}`}
      onClose={onClose}
      wide={kind !== "other" && kind !== "audio"}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {many && (
            <div className="mr-auto flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => step(-1)} aria-label="Previous attachment" title="Previous (←)">
                <IconChevronLeft size={15} /> <span className="hidden sm:inline">Previous</span>
              </Button>
              <span className="min-w-[3.5rem] text-center text-[12.5px] tabular-nums text-ink-muted">
                {idx + 1} / {items.length}
              </span>
              <Button variant="secondary" size="sm" onClick={() => step(1)} aria-label="Next attachment" title="Next (→)">
                <span className="hidden sm:inline">Next</span> <IconChevronRight size={15} />
              </Button>
            </div>
          )}
          <a href={`${src}?download=1`} className={buttonClass("secondary", "sm")} download={a.file_name}>
            <IconDownload size={14} /> <span className="hidden sm:inline">Download</span>
          </a>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div
        data-attachment-viewer
        onTouchStart={(e) => {
          e.stopPropagation(); // a presentation behind turns slides on swipe
          touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          const s0 = touch.current;
          touch.current = null;
          if (!s0 || !many) return;
          const dx = e.changedTouches[0].clientX - s0.x;
          const dy = e.changedTouches[0].clientY - s0.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        }}
      >
        <FileView key={a.id} a={a} base={base} />
      </div>
    </Sheet>
  );
}

/** One file's body: an image, a PDF, a video or audio clip, a text file, or a card with a download for everything else. */
function FileView({ a, base }: { a: TaskAttachment; base: string }) {
  const kind = kindOf(a.mime, a.file_name);
  const src = `${base}/${a.id}`;
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind === "text");
  useEffect(() => {
    if (kind !== "text") return;
    let alive = true;
    fetch(`${src}?proxy=1`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (alive) setText(t.length > 200_000 ? `${t.slice(0, 200_000)}\n… (truncated — download for the full file)` : t);
      })
      .catch(() => {
        if (alive) setText("Couldn't load the file.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [kind, src]);

  return (
    <>
      {kind === "image" && <ImageView src={src} a={a} />}
      {kind === "pdf" && <PdfView src={src} a={a} />}
      {kind === "video" && <VideoView src={src} a={a} />}
      {kind === "audio" && (
        <div className="flex flex-col items-center gap-4 rounded-lg bg-canvas px-4 py-8">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-white">
            <IconMic size={24} />
          </span>
          <audio src={src} controls preload="metadata" className="w-full" />
        </div>
      )}
      {kind === "text" && (loading ? <div className="flex justify-center py-10"><Spinner /></div> : <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 font-mono text-[12.5px] leading-relaxed text-ink">{text}</pre>)}
      {kind === "other" && (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-canvas px-4 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface text-ink-subtle ring-1 ring-inset ring-line">
            {kind === "other" && /\.(png|jpe?g|webp|gif)$/i.test(a.file_name) ? <IconImage size={24} /> : <IconFile size={24} />}
          </span>
          <p className="text-[13.5px] font-medium text-ink">{a.file_name}</p>
          <p className="max-w-sm text-[12.5px] text-ink-muted">This {fileLabel(a)} can&rsquo;t be shown in the browser. Download it to open it on your computer.</p>
          <a href={`${src}?download=1`} className={buttonClass("primary", "sm")} download={a.file_name}>
            <IconDownload size={14} /> Download {fmtBytes(a.size_bytes)}
          </a>
        </div>
      )}
    </>
  );
}

/**
 * The file's bytes with live progress — how Drive, Slack and WhatsApp Web open a file:
 * a ring with the percentage and "1.2 of 2.6 MB" while it downloads, then the file.
 * A file the browser already holds (opened before, or preloaded as a neighbour)
 * arrives at once and the ring never shows. Moving on or closing cancels the download.
 */
function useFileBytes(src: string) {
  const [state, setState] = useState<{ url: string | null; loaded: number; total: number; error: boolean }>({ url: null, loaded: 0, total: 0, error: false });
  useEffect(() => {
    const ctrl = new AbortController();
    let url: string | null = null;
    (async () => {
      try {
        const r = await fetch(src, { credentials: "same-origin", signal: ctrl.signal });
        if (!r.ok || !r.body) throw new Error(String(r.status));
        const total = Number(r.headers.get("content-length") || 0);
        const reader = r.body.getReader();
        const parts: Uint8Array[] = [];
        let loaded = 0;
        let shown = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          loaded += value.byteLength;
          // Repaint the ring at most every ~3% (a 10 MB file is hundreds of chunks).
          if (!total || loaded - shown > total / 33) {
            shown = loaded;
            setState((st) => ({ ...st, loaded, total }));
          }
        }
        url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: r.headers.get("content-type") || "" }));
        setState({ url, loaded, total: total || loaded, error: false });
      } catch {
        if (!ctrl.signal.aborted) setState((st) => ({ ...st, error: true }));
      }
    })();
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);
  return state;
}

/** The loading card: a progress ring (or a spinner while the size is unknown), the name and the bytes so far. */
function FileLoading({ a, loaded, total }: { a: TaskAttachment; loaded: number; total: number }) {
  const size = total || a.size_bytes;
  const pct = size ? Math.min(100, Math.round((loaded / size) * 100)) : 0;
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 text-center" role="status" aria-live="polite">
      {/* Until the first bytes arrive (the server is fetching from storage) a spinning arc;
          then the ring fills with the real progress. */}
      <svg width="56" height="56" viewBox="0 0 56 56" className={loaded ? "-rotate-90" : "animate-spin"} aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="4" className="stroke-line" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-ink transition-[stroke-dashoffset] duration-200"
          strokeDasharray={c}
          strokeDashoffset={loaded ? c * (1 - pct / 100) : c * 0.75}
        />
      </svg>
      <div>
        <p className="max-w-[min(28rem,80vw)] truncate text-[13px] font-medium text-ink" data-nowrap>Loading {a.file_name}</p>
        <p className="mt-0.5 text-[12px] tabular-nums text-ink-subtle">{loaded ? `${pct}% · ${fmtBytes(loaded)} of ${fmtBytes(size)}` : `Preparing ${fmtBytes(size)}…`}</p>
      </div>
    </div>
  );
}

function LoadFailed({ src, a }: { src: string; a: TaskAttachment }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 text-center">
      <p className="text-[13px] text-ink-muted">Couldn&rsquo;t load {a.file_name}. Check the connection, or download it instead.</p>
      <a href={`${src}?download=1`} className={buttonClass("secondary", "sm")} download={a.file_name}>
        <IconDownload size={14} /> Download
      </a>
    </div>
  );
}

function ImageView({ src, a }: { src: string; a: TaskAttachment }) {
  const f = useFileBytes(src);
  return (
    <div className="flex min-h-[40vh] max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-canvas">
      {f.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={f.url} alt={a.file_name} className="max-h-[70vh] max-w-full object-contain animate-fade-in" />
      ) : f.error ? (
        <LoadFailed src={src} a={a} />
      ) : (
        <FileLoading a={a} loaded={f.loaded} total={f.total} />
      )}
    </div>
  );
}

function PdfView({ src, a }: { src: string; a: TaskAttachment }) {
  const f = useFileBytes(src);
  return f.url ? (
    <iframe src={f.url} title={a.file_name} className="h-[70vh] w-full rounded-lg border border-line bg-white" />
  ) : (
    <div className="flex h-[70vh] items-center justify-center rounded-lg border border-line bg-canvas">{f.error ? <LoadFailed src={src} a={a} /> : <FileLoading a={a} loaded={f.loaded} total={f.total} />}</div>
  );
}

/** Video streams as it plays (seeking works), so it gets a spinner until it can start, not a download ring. */
function VideoView({ src, a }: { src: string; a: TaskAttachment }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="relative">
      {!ready && (
        <div className="absolute inset-0 z-[1] flex items-center justify-center rounded-lg bg-black/70 text-white">
          <div className="flex flex-col items-center gap-2 text-[12.5px]">
            <Spinner />
            Loading {a.file_name}
          </div>
        </div>
      )}
      <video src={src} controls autoPlay playsInline preload="metadata" onCanPlay={() => setReady(true)} onError={() => setReady(true)} className="aspect-video w-full rounded-lg bg-black" />
    </div>
  );
}
