"use client";

import { useRef, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { mutate, mutateWhere, useCachedFetch } from "@/lib/client-cache";
import { deleteJson, postJson } from "@/lib/http";
import { compressImage } from "@/lib/image-compress";
import { fmtBytes } from "@/lib/format";
import { LIMITS } from "@/lib/domain";
import { When } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { IconPaperclip, IconUpload, IconFile, IconTrash, IconVideo, IconMic, IconX } from "@/components/ui/icons";
import { DownloadButton } from "@/components/ui/download-button";
import type { MeetingFile, TaskAttachment, TaskDetail } from "@/lib/types";
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

/** One PUT of a piece of a large file to its storage upload session, with progress. */
function putPiece(url: string, body: Blob | null, range: string, onProgress: (loaded: number) => void): Promise<{ status: number; range: string | null }> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Range", range);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve({ status: x.status, range: x.getResponseHeader("range") });
    x.onerror = () => resolve({ status: 0, range: null });
    x.ontimeout = () => resolve({ status: 0, range: null });
    x.timeout = 10 * 60_000;
    x.send(body);
  });
}

/**
 * A file over the one-request size (up to 500 MB): the panel opens a resumable
 * session in the team storage, the browser sends the file there itself in
 * pieces — a dropped connection resumes from the last piece the storage
 * confirmed — and the panel then checks and records it.
 */
async function uploadLarge<T extends TaskAttachment>(base: string, file: File, extra: Record<string, string>, onProgress: (ratio: number) => void, onSaving: () => void): Promise<T> {
  const start = await postJson<{ url?: string; token?: string; chunk?: number; error?: string }>(`${base}/upload`, { name: file.name, size: file.size, ...extra });
  if (!start.ok || !start.data?.url || !start.data.token) throw new Error(start.data?.error || "Couldn't start the upload");
  const { url, token } = start.data;
  const piece = start.data.chunk || 32 * 1024 * 1024;
  const total = file.size;
  // Where the storage says it stands: the next byte it wants (or `total` when it has everything).
  const next = (range: string | null) => (range ? Number(range.split("-")[1]) + 1 : 0);
  let offset = 0;
  let tries = 0;
  for (;;) {
    const end = Math.min(offset + piece, total);
    const r = await putPiece(url, file.slice(offset, end), `bytes ${offset}-${end - 1}/${total}`, (loaded) => onProgress(Math.min(0.999, (offset + loaded) / total)));
    if (r.status === 200 || r.status === 201) break;
    if (r.status === 308) {
      offset = next(r.range);
      tries = 0;
      onProgress(offset / total);
      continue;
    }
    // Network drop or a server hiccup: ask where it stands, then carry on from there.
    if (++tries > 4 || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) throw new Error(r.status === 404 || r.status === 410 ? "The upload expired — add the file again" : "Upload failed — check the connection and add the file again");
    await new Promise((res) => setTimeout(res, 1000 * tries));
    const s = await putPiece(url, null, `bytes */${total}`, () => undefined);
    if (s.status === 200 || s.status === 201) break;
    if (s.status === 308) offset = next(s.range);
  }
  onProgress(1);
  onSaving();
  const done = await postJson<{ attachment?: T; error?: string }>(`${base}/upload`, { token }, "PUT");
  if (!done.ok || !done.data?.attachment) throw new Error(done.data?.error || "Couldn't save the file");
  return done.data.attachment;
}

/**
 * Adding files, shared by every files card: name order, three at a time, a real
 * progress bar per file (one request up to 24 MB, straight to storage in pieces
 * above that), each placed in the owner's cached data as it lands, and the
 * picked order sent once at the end. `extra` goes with every file (a meeting
 * file's note and upload group).
 */
function useAttachmentUpload<T extends TaskAttachment>({ base, max, count, cacheKey, onLanded, limitText }: { base: string; max: number; count: number; cacheKey: string; onLanded: (mine: T[]) => void; limitText: string }) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState<UploadRow[]>([]);
  async function upload(files: FileList | File[], extra: Record<string, string> = {}) {
    if (uploading.some((u) => u.phase === "waiting" || u.phase === "sending" || u.phase === "saving")) {
      toast("Still uploading — add more files once this batch finishes", "error");
      return;
    }
    // In name order, numbers counted as numbers (2 before 10), as Explorer and Finder list them.
    // The order a picker hands over is not the order of the clicks — Windows moves the
    // first-clicked file to the end — so name order is the one people actually see.
    const list = Array.from(files)
      .sort((x, y) => byName.compare(x.name, y.name))
      .slice(0, max - count);
    if (!list.length) {
      toast(limitText, "error");
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
    const landed: (T | undefined)[] = [];
    const finished: string[] = [];
    const place = () => onLanded(landed.filter((a): a is T => !!a));
    const queue = list.map((f, i) => [f, i] as const);
    const one = async (original: File, i: number) => {
      set(i, { phase: "sending" });
      try {
        const file = await compressImage(original);
        if (file.size > LIMITS.attachmentBytes) throw new Error(`${original.name} is over ${Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB`);
        set(i, { size: file.size });
        let attachment: T;
        if (file.size > LIMITS.attachmentInlineBytes) {
          attachment = await uploadLarge<T>(base, file, extra, (ratio) => set(i, { progress: ratio, phase: "sending" }), () => set(i, { phase: "saving" }));
        } else {
          const fd = new FormData();
          fd.append("file", file, file.name);
          for (const [k, v] of Object.entries(extra)) fd.append(k, v);
          const { ok, data } = await postWithProgress(base, fd, (ratio) => set(i, { progress: ratio, phase: ratio >= 0.999 ? "saving" : "sending" }));
          if (!ok || !data?.attachment) throw new Error(data?.error || "Upload failed");
          attachment = data.attachment as T;
        }
        added++;
        landed[i] = attachment;
        finished.push(attachment.id);
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
      const picked = landed.filter((a): a is T => !!a).map((a) => a.id);
      if (picked.join() !== finished.join()) await postJson(base, { order: picked }, "PATCH");
      mutate(cacheKey);
    }
    window.setTimeout(() => {
      setUploading((cur) => cur.filter((x) => x.phase === "error"));
      thumbs.forEach((t) => t && URL.revokeObjectURL(t));
    }, 1500);
  }

  const busy = uploading.some((u) => u.phase === "waiting" || u.phase === "sending" || u.phase === "saving");
  return { uploading, upload, busy };
}

/** The progress rows under a files card while a batch goes up. */
function UploadRows({ uploading }: { uploading: UploadRow[] }) {
  if (!uploading.length) return null;
  return (
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
  );
}

/**
 * Files on a task, kept in the team's Google Shared Drive: images in a grid,
 * everything else as a list, each with a preview sheet that fits its type.
 * Uploads show a real progress bar, then "Saving…" until it is stored.
 */
export function TaskAttachments({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  return (
    <AttachmentsCard
      base={`/api/tasks/${task.id}/attachments`}
      items={task.attachments}
      max={LIMITS.attachmentsPerTask}
      cacheKey={cacheKey}
      // Placed into the open task as each file lands (no refetch per file).
      onLanded={(mine) =>
        mutateWhere(cacheKey, (d, key) => {
          const t = key === cacheKey ? (d as { task?: TaskDetail } | undefined)?.task : undefined;
          if (!t) return undefined;
          const ids = new Set(mine.map((a) => a.id));
          return { ...(d as object), task: { ...t, attachments: [...t.attachments.filter((a) => !ids.has(a.id)), ...mine] } };
        })
      }
      limitText={`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`}
      emptyHint="Screenshots, screen recordings, logs, designs, builds"
    />
  );
}

/**
 * The files card itself — shared by tasks and meetings: add (pick, drop),
 * progress per file, pictures as a grid and other files as a list, the
 * full-screen viewer, download and remove.
 */
export function AttachmentsCard({ base, items, max, cacheKey, onLanded, limitText, emptyHint, title = "Attachments", disabledText, compact }: {
  base: string;
  items: TaskAttachment[];
  max: number;
  cacheKey: string;
  /** Put the newly landed files into the owner's cached data (in picked order). */
  onLanded: (mine: TaskAttachment[]) => void;
  limitText: string;
  emptyHint: string;
  title?: string;
  /** Shown instead of the add button when files can't be added here (storage not set up). */
  disabledText?: string;
  /** A narrow column (the meeting page's side): fewer picture columns. */
  compact?: boolean;
}) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const { uploading, upload } = useAttachmentUpload<TaskAttachment>({ base, max, count: items.length, cacheKey, onLanded, limitText });
  const [dragging, setDragging] = useState(false);
  // The viewer walks the files in the order they are shown (pictures, then other files).
  const [preview, setPreview] = useState<TaskAttachment | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  async function remove(a: TaskAttachment) {
    if (!(await confirm({ title: `Remove “${a.file_name}”?`, message: "The file is deleted permanently — it can't be recovered.", confirmLabel: "Remove", tone: "danger" }))) return;
    // The row goes at once; the file is deleted for good in the background and only returns if that fails.
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

  const visible = items.filter((a) => !gone.has(a.id));
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
        if (e.dataTransfer.files?.length && !disabledText) void upload(e.dataTransfer.files);
      }}
    >
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle className="inline-flex items-center gap-2">
          <IconPaperclip size={16} className="text-ink-subtle" /> {title}
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
        {!disabledText && (
          <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
            <IconUpload size={14} /> Add files
          </Button>
        )}
      </CardHeader>

      {visible.length === 0 && uploading.length === 0 && (
        <CardBody>
          <p className="text-sm text-ink-subtle">
            {disabledText ?? (
              <>
                {emptyHint} — drop files here or click <b>Add files</b>. Up to {Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB per file; images are downscaled before upload.
              </>
            )}
          </p>
        </CardBody>
      )}

      {images.length > 0 && (
        <CardBody className={cn("grid grid-cols-2 gap-3", compact ? "sm:grid-cols-3 xl:grid-cols-2" : "sm:grid-cols-3 lg:grid-cols-4")}>
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
                <DownloadButton url={`${base}/${a.id}`} name={a.file_name} size={a.size_bytes} iconOnly plain className="tap h-8 min-w-8 px-1.5 text-ink-subtle hover:bg-canvas hover:text-ink" />
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

      <UploadRows uploading={uploading} />

      {preview && (
        <AttachmentViewer items={[...images, ...files]} startId={preview.id} base={base} onClose={() => setPreview(null)} />
      )}
    </Card>
  );
}

/** A meeting's files as items: one per upload, titled by the note asked when it was added (in the order added). */
export interface MeetingItem {
  id: string;
  title: string;
  note: string | null;
  files: MeetingFile[];
}
export function meetingItems(files: MeetingFile[]): MeetingItem[] {
  const byGroup = new Map<string, MeetingFile[]>();
  for (const f of files) byGroup.set(f.group_id, [...(byGroup.get(f.group_id) ?? []), f]);
  return [...byGroup.entries()].map(([id, list]) => {
    // Pictures first inside an item, like a task's attachments.
    const ordered = [...list.filter((f) => kindOf(f.mime, f.file_name) === "image"), ...list.filter((f) => kindOf(f.mime, f.file_name) !== "image")];
    const note = list.find((f) => f.note)?.note ?? null;
    return { id, title: note || list[0].file_name, note, files: ordered };
  });
}

/**
 * The meeting page's attachments: each upload is an item — the note asked when
 * it was added as its title, and a paperclip with the count that opens its files
 * full screen (zoom, previous / next), like a task's attachments. The same items
 * are a slide in the meeting's presentation.
 */
export function MeetingFilesCard({ meetingId }: { meetingId: string }) {
  const key = `/api/meetings/${meetingId}/attachments`;
  const { data } = useCachedFetch<{ attachments: MeetingFile[]; enabled: boolean }>(key);
  const files = data?.attachments ?? [];
  const { toast } = useToast();
  const { confirm, prompt } = useDialog();
  const { me, isAdmin } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<MeetingItem | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const { uploading, upload, busy } = useAttachmentUpload<MeetingFile>({
    base: key,
    max: LIMITS.attachmentsPerMeeting,
    count: files.length,
    cacheKey: key,
    limitText: `A meeting can hold up to ${LIMITS.attachmentsPerMeeting} files`,
    onLanded: (mine) =>
      mutateWhere(key, (d, k) => {
        if (k !== key) return undefined;
        const cur = d as { attachments?: MeetingFile[]; enabled?: boolean } | undefined;
        const ids = new Set(mine.map((a) => a.id));
        return { enabled: cur?.enabled ?? true, attachments: [...(cur?.attachments ?? []).filter((a) => !ids.has(a.id)), ...mine] };
      }),
  });
  const disabled = !!data && !data.enabled;
  const items = meetingItems(files.filter((f) => !gone.has(f.id)));

  /** Ask for the note (the item's title), then upload the picked files as one item. */
  async function add(list: FileList | File[]) {
    const picked = Array.from(list);
    if (!picked.length) return;
    if (busy) return toast("Still uploading — add more once this finishes", "error");
    const one = picked.length === 1 ? picked[0].name.replace(/\.[^.]+$/, "") : "";
    const note = await prompt({
      title: picked.length === 1 ? "Add a note for this file" : `Add a note for these ${picked.length} files`,
      message: "It is the title people see on the meeting and in its presentation.",
      placeholder: "e.g. New onboarding screens to review",
      defaultValue: one,
      confirmLabel: "Upload",
    });
    if (note === null) return; // cancelled: nothing is uploaded
    void upload(picked, { note: note.trim() || one || picked[0].name, group: crypto.randomUUID() });
  }

  async function remove(item: MeetingItem) {
    const n = item.files.length;
    if (!(await confirm({ title: `Remove “${item.title}”?`, message: `${n === 1 ? "Its file is" : `Its ${n} files are`} deleted permanently — ${n === 1 ? "it" : "they"} can’t be recovered.`, confirmLabel: "Remove", tone: "danger" }))) return;
    // The item goes at once; its files are deleted for good in the background and come back only if that fails.
    setGone((prev) => new Set([...prev, ...item.files.map((f) => f.id)]));
    const results = await Promise.all(item.files.map((f) => deleteJson(`${key}/${f.id}`)));
    const failed = item.files.filter((_, i) => !results[i].ok);
    mutate(key);
    if (failed.length) {
      setGone((prev) => {
        const next = new Set(prev);
        for (const f of failed) next.delete(f.id);
        return next;
      });
      toast(results.find((r) => !r.ok)?.data?.error || "Couldn’t remove every file", "error");
    }
  }
  const canRemove = (item: MeetingItem) => isAdmin || item.files.every((f) => f.uploaded_by?.id === me?.id);

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
        if (e.dataTransfer.files?.length && !disabled) void add(e.dataTransfer.files);
      }}
    >
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle className="inline-flex items-center gap-2">
          <IconPaperclip size={16} className="text-ink-subtle" /> Attachments
          {items.length > 0 && <span className="text-sm font-normal text-ink-subtle">{items.length}</span>}
        </CardTitle>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files);
            e.target.value = "";
          }}
        />
        {!disabled && (
          <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
            <IconUpload size={14} /> Add
          </Button>
        )}
      </CardHeader>

      {items.length === 0 && uploading.length === 0 && (
        <CardBody>
          <p className="text-[12.5px] text-ink-subtle">
            {disabled ? "File storage isn’t set up on this server yet." : <>Slides, specs, designs, screenshots — with a note each. Shown in the presentation too. Up to {Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB per file.</>}
          </p>
        </CardBody>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-line/80">
          {items.map((item) => {
            const first = item.files[0];
            const pic = kindOf(first.mime, first.file_name) === "image";
            const by = first.uploaded_by;
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <button type="button" onClick={() => setOpen(item)} className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-canvas text-ink-subtle ring-1 ring-inset ring-line hover:text-ink" aria-label={`Open ${item.title}`}>
                  {pic ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${key}/${first.id}`} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  ) : (
                    <IconFile size={17} />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setOpen(item)} title={item.title} className="line-clamp-2 block max-w-full break-words text-left text-[13.5px] font-medium leading-snug text-ink hover:text-brand-700">
                    {item.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-subtle">
                    <span className="truncate" title={item.files.map((f) => f.file_name).join(", ")}>
                      {item.files.length === 1 ? `${fileLabel(first)} · ${fmtBytes(first.size_bytes)}` : `${item.files.length} files`}
                    </span>
                    {by && <span>· {by.name}</span>}
                    <span>
                      · <When iso={first.created_at} />
                    </span>
                  </div>
                </div>
                <button type="button" onClick={() => setOpen(item)} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-[12px] font-semibold text-ink-muted ring-1 ring-inset ring-line hover:text-ink hover:ring-ink/40" title={`${item.files.length} attachment${item.files.length === 1 ? "" : "s"} — open full screen`} aria-label={`Open ${item.files.length} attachment${item.files.length === 1 ? "" : "s"} full screen`}>
                  <IconPaperclip size={12} />
                  {item.files.length}
                </button>
                {canRemove(item) && (
                  <button type="button" onClick={() => remove(item)} className="tap shrink-0 rounded-md p-1 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${item.title}`} title="Remove">
                    <IconTrash size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <UploadRows uploading={uploading} />

      {open && <AttachmentViewer items={open.files} base={key} onClose={() => setOpen(null)} />}
    </Card>
  );
}
