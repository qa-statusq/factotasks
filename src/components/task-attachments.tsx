"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { mutate } from "@/lib/client-cache";
import { deleteJson } from "@/lib/http";
import { compressImage } from "@/lib/image-compress";
import { formatBytes } from "@/lib/attachments";
import { LIMITS } from "@/lib/domain";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { IconPaperclip, IconUpload, IconFile, IconTrash, IconDownload, IconImage, IconVideo, IconMic, IconX } from "@/components/ui/icons";
import type { TaskAttachment, TaskDetail } from "@/lib/types";

type Kind = "image" | "pdf" | "video" | "audio" | "text" | "other";
function kindOf(mime: string, name: string): Kind {
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(md|log|txt|csv|json)$/i.test(name)) return "text";
  return "other";
}
const KIND_LABEL: Record<Kind, string> = { image: "image", pdf: "PDF", video: "video", audio: "audio", text: "text", other: "file" };
function fileLabel(a: TaskAttachment): string {
  const ext = a.file_name.split(".").pop()?.toUpperCase();
  if (/apk|aab|ipa/i.test(ext ?? "")) return `${ext} build`;
  if (/docx?|xlsx?|pptx?/i.test(ext ?? "")) return `${ext} document`;
  if (ext === "ZIP") return "archive";
  return KIND_LABEL[kindOf(a.mime, a.file_name)];
}

interface UploadRow {
  name: string;
  size: number;
  /** 0..1 sent to the panel; then "saving" while the panel hands it to Drive. */
  progress: number;
  phase: "sending" | "saving" | "done" | "error";
  error?: string;
}

/** PUT/POST with upload progress (XHR is the only browser API that reports it). */
function postWithProgress(url: string, body: FormData, onProgress: (ratio: number) => void): Promise<{ ok: boolean; data: { error?: string } | null }> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.withCredentials = true;
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    x.onload = () => {
      let data: { error?: string } | null = null;
      try {
        data = JSON.parse(x.responseText || "null");
      } catch {
        data = null;
      }
      resolve({ ok: x.status >= 200 && x.status < 300, data });
    };
    x.onerror = () => resolve({ ok: false, data: { error: "Network error" } });
    x.ontimeout = () => resolve({ ok: false, data: { error: "Upload timed out" } });
    x.timeout = 10 * 60_000;
    x.send(body);
  });
}

/**
 * Files on a task, kept in the team's Google Shared Drive: images in a grid,
 * everything else as a list, each with a preview sheet that fits its type.
 * Uploads show a real progress bar, then "Saving to Drive" until it is there.
 */
export function TaskAttachments({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<TaskAttachment | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const base = `/api/tasks/${task.id}/attachments`;

  async function upload(files: FileList | File[]) {
    if (uploading.some((u) => u.phase === "sending" || u.phase === "saving")) {
      toast("Still uploading — add more files once this batch finishes", "error");
      return;
    }
    const list = Array.from(files).slice(0, LIMITS.attachmentsPerTask - task.attachments.length);
    if (!list.length) {
      toast(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`, "error");
      return;
    }
    setUploading(list.map((f) => ({ name: f.name, size: f.size, progress: 0, phase: "sending" })));
    const set = (i: number, p: Partial<UploadRow>) => setUploading((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));
    let added = 0;
    for (let i = 0; i < list.length; i++) {
      const original = list[i];
      try {
        const file = await compressImage(original);
        if (file.size > LIMITS.attachmentBytes) throw new Error(`${original.name} is over ${Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB`);
        set(i, { size: file.size });
        const fd = new FormData();
        fd.append("file", file, file.name);
        const { ok, data } = await postWithProgress(base, fd, (ratio) => set(i, { progress: ratio, phase: ratio >= 0.999 ? "saving" : "sending" }));
        if (!ok) throw new Error(data?.error || "Upload failed");
        added++;
        set(i, { progress: 1, phase: "done" });
        mutate(cacheKey);
      } catch (e) {
        set(i, { phase: "error", error: (e as Error).message });
      }
    }
    if (added) toast(added === 1 ? "File attached" : `${added} files attached`);
    window.setTimeout(() => setUploading((cur) => cur.filter((x) => x.phase === "error")), 1500);
  }

  async function remove(a: TaskAttachment) {
    if (!(await confirm({ title: `Remove “${a.file_name}”?`, confirmLabel: "Remove", tone: "danger" }))) return;
    // The row goes at once; the file is binned in the background and only returns if that fails.
    setGone((prev) => new Set(prev).add(a.id));
    const { ok, data } = await deleteJson(`${base}/${a.id}`);
    if (ok) mutate(cacheKey);
    else {
      setGone((prev) => {
        const n = new Set(prev);
        n.delete(a.id);
        return n;
      });
      toast(data?.error || "Couldn't remove the file", "error");
    }
  }

  const visible = task.attachments.filter((a) => !gone.has(a.id));
  const images = visible.filter((a) => kindOf(a.mime, a.file_name) === "image");
  const files = visible.filter((a) => kindOf(a.mime, a.file_name) !== "image");
  const canRemove = (a: TaskAttachment) => a.uploaded_by?.id === me?.id || isAdmin;

  return (
    <Card
      className={cn("transition-colors", dragging && "border-brand-300 bg-brand-50/40")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
      }}
    >
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle className="inline-flex items-center gap-2">
          <IconPaperclip size={16} className="text-ink-subtle" /> Attachments
          {visible.length > 0 && <span className="text-sm font-normal text-ink-subtle">{visible.length}</span>}
        </CardTitle>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
          <IconUpload size={14} /> Add files
        </Button>
      </CardHeader>

      {visible.length === 0 && uploading.length === 0 && (
        <CardBody>
          <p className="text-sm text-ink-subtle">
            Screenshots, screen recordings, logs, designs, builds — drop files here or click <b>Add files</b>. Images are downscaled before upload.
          </p>
        </CardBody>
      )}

      {images.length > 0 && (
        <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((a) => (
            <figure key={a.id} className="group relative overflow-hidden rounded-xl border border-line bg-canvas">
              <button type="button" onClick={() => setPreview(a)} className="block aspect-[4/3] w-full" aria-label={`Preview ${a.file_name}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${base}/${a.id}`} alt={a.file_name} loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
              </button>
              <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-ink-muted">
                <span className="truncate" title={`${a.file_name} · ${formatBytes(a.size_bytes)}${a.width ? ` · ${a.width}×${a.height}` : ""}`}>
                  {a.file_name}
                </span>
                {canRemove(a) && (
                  <button type="button" onClick={() => remove(a)} className="shrink-0 rounded p-0.5 text-ink-subtle hover:text-red-600" aria-label={`Remove ${a.file_name}`}>
                    <IconTrash size={13} />
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </CardBody>
      )}

      {files.length > 0 && (
        <ul className={cn("divide-y divide-line/80", images.length > 0 && "border-t border-line/80")}>
          {files.map((a) => {
            const kind = kindOf(a.mime, a.file_name);
            return (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <button type="button" onClick={() => setPreview(a)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-subtle ring-1 ring-inset ring-line hover:text-ink" aria-label={`Preview ${a.file_name}`}>
                  {kind === "video" ? <IconVideo size={16} /> : kind === "audio" ? <IconMic size={16} /> : <IconFile size={16} />}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setPreview(a)} className="block max-w-full truncate text-left text-sm font-medium text-ink hover:text-brand-700">
                    {a.file_name}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-subtle">
                    <span>{formatBytes(a.size_bytes)}</span>
                    <span>· {fileLabel(a)}</span>
                    {a.uploaded_by && (
                      <span className="inline-flex items-center gap-1">
                        · <Avatar user={a.uploaded_by} size="xs" /> {a.uploaded_by.name}
                      </span>
                    )}
                    <span title={istTime(a.created_at)}>
                      · <RelTime iso={a.created_at} />
                    </span>
                  </div>
                </div>
                <a href={`${base}/${a.id}?download=1`} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label="Download" title="Download">
                  <IconDownload size={16} />
                </a>
                {canRemove(a) && (
                  <button type="button" onClick={() => remove(a)} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${a.file_name}`}>
                    <IconTrash size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {uploading.length > 0 && (
        <ul className="border-t border-line/80 px-4 py-2 sm:px-5">
          {uploading.map((u, i) => (
            <li key={i} className="py-1.5 text-xs">
              <div className={cn("flex items-center gap-2", u.phase === "error" ? "text-red-600" : "text-ink-muted")}>
                {u.phase === "done" ? <span className="text-emerald-600">✓</span> : u.phase === "error" ? <IconX size={12} /> : <Spinner className="h-3 w-3" />}
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="shrink-0 tabular-nums">{u.phase === "sending" ? `${Math.round(u.progress * 100)}% · ${formatBytes(u.size)}` : u.phase === "saving" ? "Saving…" : u.phase === "done" ? "Attached" : u.error}</span>
              </div>
              {(u.phase === "sending" || u.phase === "saving") && (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-line/70">
                  <div className={cn("h-full rounded-full bg-brand-600 transition-[width] duration-200", u.phase === "saving" && "animate-pulse")} style={{ width: `${Math.max(3, Math.round(u.progress * 100))}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {preview && <AttachmentPreview a={preview} base={base} onClose={() => setPreview(null)} />}
    </Card>
  );
}

/** One sheet, one file: an image, a PDF, a video or audio clip, a text file, or a card with a download for everything else. */
function AttachmentPreview({ a, base, onClose }: { a: TaskAttachment; base: string; onClose: () => void }) {
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
    <Sheet
      title={a.file_name}
      description={`${formatBytes(a.size_bytes)}${a.width ? ` · ${a.width}×${a.height}` : ""} · ${fileLabel(a)}${a.uploaded_by ? ` · ${a.uploaded_by.name}` : ""}`}
      onClose={onClose}
      wide={kind !== "other" && kind !== "audio"}
      footer={
        <div className="flex items-center justify-end gap-2">
          <a href={`${src}?download=1`} className={buttonClass("secondary", "sm")} download={a.file_name}>
            <IconDownload size={14} /> Download
          </a>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      {kind === "image" && (
        <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={a.file_name} className="max-h-[70vh] max-w-full object-contain" />
        </div>
      )}
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
            <IconDownload size={14} /> Download {formatBytes(a.size_bytes)}
          </a>
        </div>
      )}
    </Sheet>
  );
}
