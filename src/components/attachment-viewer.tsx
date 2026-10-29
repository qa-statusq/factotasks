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
      {kind === "image" && <ImageView src={src} alt={a.file_name} />}
      {kind === "pdf" && <iframe src={src} title={a.file_name} className="h-[70vh] w-full rounded-lg border border-line bg-white" />}
      {kind === "video" && <video src={src} controls autoPlay playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black" />}
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

/** A picture with a spinner until it has arrived (no blank box while it downloads). */
function ImageView({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative flex min-h-[40vh] max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-canvas">
      {!loaded && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} className={`max-h-[70vh] max-w-full object-contain transition-opacity duration-150 ${loaded ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}
