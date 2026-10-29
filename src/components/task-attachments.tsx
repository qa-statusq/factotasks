"use client";

import { useRef, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { mutate, mutateWhere } from "@/lib/client-cache";
import { deleteJson, postJson } from "@/lib/http";
import { compressImage } from "@/lib/image-compress";
import { fmtBytes } from "@/lib/format";
import { LIMITS } from "@/lib/domain";
import { When } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { IconPaperclip, IconUpload, IconFile, IconTrash, IconDownload, IconVideo, IconMic, IconX } from "@/components/ui/icons";
import type { TaskAttachment, TaskDetail } from "@/lib/types";
import { AttachmentViewer, kindOf, fileLabel } from "@/components/attachment-viewer";

interface UploadRow {
  name: string;
  size: number;
  /** 0..1 sent to the panel; then "saving" while the panel stores it. */
  progress: number;
  phase: "waiting" | "sending" | "saving" | "done" | "error";
  error?: string;
  /** A picture's local preview while it uploads (object URL, revoked when the row goes). */
  thumb?: string;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Files upload this many at a time (one at a time made a batch of screenshots crawl).
const PARALLEL_UPLOADS = 3;

/** PUT/POST with upload progress (XHR is the only browser API that reports it). */
function postWithProgress(url: string, body: FormData, onProgress: (ratio: number) => void): Promise<{ ok: boolean; data: { error?: string; attachment?: TaskAttachment } | null }> {
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
 * Uploads show a real progress bar, then "Saving…" until it is stored.
 */
export function TaskAttachments({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  // The viewer walks the files in the order they are shown (pictures, then other files).
  const [preview, setPreview] = useState<TaskAttachment | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const base = `/api/tasks/${task.id}/attachments`;

  async function upload(files: FileList | File[]) {
    if (uploading.some((u) => u.phase === "waiting" || u.phase === "sending" || u.phase === "saving")) {
      toast("Still uploading — add more files once this batch finishes", "error");
      return;
    }
    // In name order, numbers counted as numbers (2 before 10), as Explorer and Finder list them.
    // The order a picker hands over is not the order of the clicks — Windows moves the
    // first-clicked file to the end — so name order is the one people actually see.
    const list = Array.from(files)
      .sort((x, y) => byName.compare(x.name, y.name))
      .slice(0, LIMITS.attachmentsPerTask - task.attachments.length);
    if (!list.length) {
      toast(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`, "error");
      return;
    }
    // A picture shows at once from the device (no waiting for the upload to see what is going up).
    const thumbs = list.map((f) => (/^image\/(png|jpeg|webp|gif)$/.test(f.type) ? URL.createObjectURL(f) : undefined));
    setUploading(list.map((f, i) => ({ name: f.name, size: f.size, progress: 0, phase: "waiting", thumb: thumbs[i] })));
    const set = (i: number, p: Partial<UploadRow>) => setUploading((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));
    let added = 0;
    // Files upload several at a time and so FINISH in any order; the task still lists
    // them in the order they were picked — placed locally as each one lands, then
    // the server is told the order once, at the end (one request, only if needed).
    const landed: (TaskAttachment | undefined)[] = [];
    const finished: string[] = [];
    const place = () =>
      mutateWhere(cacheKey, (d, key) => {
        const t = key === cacheKey ? (d as { task?: TaskDetail } | undefined)?.task : undefined;
        if (!t) return undefined;
        const mine = landed.filter((a): a is TaskAttachment => !!a);
        const ids = new Set(mine.map((a) => a.id));
        return { ...(d as object), task: { ...t, attachments: [...t.attachments.filter((a) => !ids.has(a.id)), ...mine] } };
      });
    const queue = list.map((f, i) => [f, i] as const);
    const one = async (original: File, i: number) => {
      set(i, { phase: "sending" });
      try {
        const file = await compressImage(original);
        if (file.size > LIMITS.attachmentBytes) throw new Error(`${original.name} is over ${Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB`);
        set(i, { size: file.size });
        const fd = new FormData();
        fd.append("file", file, file.name);
        const { ok, data } = await postWithProgress(base, fd, (ratio) => set(i, { progress: ratio, phase: ratio >= 0.999 ? "saving" : "sending" }));
        if (!ok || !data?.attachment) throw new Error(data?.error || "Upload failed");
        added++;
        landed[i] = data.attachment;
        finished.push(data.attachment.id);
        place();
        set(i, { progress: 1, phase: "done" });
      } catch (e) {
        set(i, { phase: "error", error: (e as Error).message });
      }
    };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await one(next[0], next[1]);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, list.length) }, worker));
    if (added) {
      toast(added === 1 ? "File attached" : `${added} files attached`);
      const picked = landed.filter((a): a is TaskAttachment => !!a).map((a) => a.id);
      if (picked.join() !== finished.join()) await postJson(base, { order: picked }, "PATCH");
      mutate(cacheKey);
    }
    window.setTimeout(() => {
      setUploading((cur) => cur.filter((x) => x.phase === "error"));
      thumbs.forEach((t) => t && URL.revokeObjectURL(t));
    }, 1500);
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
                <span className="truncate" title={`${a.file_name} · ${fmtBytes(a.size_bytes)}${a.width ? ` · ${a.width}×${a.height}` : ""}`}>
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
                    <span>{fmtBytes(a.size_bytes)}</span>
                    <span>· {fileLabel(a)}</span>
                    {a.uploaded_by && (
                      <span className="inline-flex items-center gap-1">
                        · <Avatar user={a.uploaded_by} size="xs" /> {a.uploaded_by.name}
                      </span>
                    )}
                    <span>
                      · <When iso={a.created_at} />
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
                {u.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={u.thumb} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover ring-1 ring-line" />
                ) : null}
                {u.phase === "done" ? <span className="text-emerald-600">✓</span> : u.phase === "error" ? <IconX size={12} /> : <Spinner className="h-3 w-3" />}
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="shrink-0 tabular-nums">{u.phase === "waiting" ? "Waiting…" : u.phase === "sending" ? `${Math.round(u.progress * 100)}% · ${fmtBytes(u.size)}` : u.phase === "saving" ? "Saving…" : u.phase === "done" ? "Attached" : u.error}</span>
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

      {preview && (
        <AttachmentViewer items={[...images, ...files]} startId={preview.id} base={base} onClose={() => setPreview(null)} />
      )}
    </Card>
  );
}
