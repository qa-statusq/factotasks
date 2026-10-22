"use client";

import { useRef, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { mutate } from "@/lib/client-cache";
import { deleteJson } from "@/lib/http";
import { timeoutSignal } from "@/lib/compat";
import { compressImage } from "@/lib/image-compress";
import { formatBytes } from "@/lib/attachments";
import { LIMITS } from "@/lib/domain";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { IconPaperclip, IconUpload, IconFile, IconTrash, IconExternal, IconDownload } from "@/components/ui/icons";
import type { TaskAttachment, TaskDetail } from "@/lib/types";

const isImage = (m: string) => /^image\/(png|jpeg|webp|gif)$/.test(m);
const isVideo = (m: string) => m.startsWith("video/");

export function TaskAttachments({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; done: boolean; error?: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const base = `/api/tasks/${task.id}/attachments`;

  async function upload(files: FileList | File[]) {
    if (uploading.some((u) => !u.done)) {
      toast("Still uploading — add more files once this batch finishes", "error");
      return;
    }
    const list = Array.from(files).slice(0, LIMITS.attachmentsPerTask - task.attachments.length);
    if (!list.length) {
      toast(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`, "error");
      return;
    }
    setUploading(list.map((f) => ({ name: f.name, done: false })));
    let added = 0;
    for (let i = 0; i < list.length; i++) {
      const original = list[i];
      try {
        const file = await compressImage(original);
        if (file.size > LIMITS.attachmentBytes) throw new Error(`${original.name} is over ${Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MB`);
        const fd = new FormData();
        fd.append("file", file, file.name);
        const r = await fetch(base, { method: "POST", body: fd, signal: timeoutSignal(90_000) });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || "Upload failed");
        added++;
        setUploading((cur) => cur.map((x, j) => (j === i ? { ...x, done: true } : x)));
      } catch (e) {
        setUploading((cur) => cur.map((x, j) => (j === i ? { ...x, done: true, error: (e as Error).message } : x)));
      }
    }
    if (added) {
      mutate(cacheKey);
      toast(added === 1 ? "File attached" : `${added} files attached`);
    }
    window.setTimeout(() => setUploading((cur) => (cur.every((x) => x.done && !x.error) ? [] : cur.filter((x) => x.error))), 1200);
  }

  async function remove(a: TaskAttachment) {
    if (!(await confirm({ title: `Remove “${a.file_name}”?`, confirmLabel: "Remove", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(`${base}/${a.id}`);
    if (ok) mutate(cacheKey);
    else toast(data?.error || "Couldn't remove the file", "error");
  }

  const images = task.attachments.filter((a) => isImage(a.mime));
  const files = task.attachments.filter((a) => !isImage(a.mime));

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
          {task.attachments.length > 0 && <span className="text-sm font-normal text-ink-subtle">{task.attachments.length}</span>}
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

      {task.attachments.length === 0 && uploading.length === 0 && (
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
              <a href={`${base}/${a.id}`} target="_blank" rel="noopener noreferrer" className="block aspect-[4/3]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${base}/${a.id}`} alt={a.file_name} loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
              </a>
              <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-ink-muted">
                <span className="truncate" title={`${a.file_name} · ${formatBytes(a.size_bytes)}${a.width ? ` · ${a.width}×${a.height}` : ""}`}>
                  {a.file_name}
                </span>
                {(a.uploaded_by?.id === me?.id || isAdmin) && (
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
          {files.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-subtle ring-1 ring-inset ring-line">
                <IconFile size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <a href={`${base}/${a.id}`} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-ink hover:text-brand-700">
                  {a.file_name}
                </a>
                <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-subtle">
                  <span>{formatBytes(a.size_bytes)}</span>
                  {isVideo(a.mime) && <span>· video</span>}
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
              <a href={`${base}/${a.id}`} target="_blank" rel="noopener noreferrer" className="tap hidden rounded-md p-1.5 text-ink-subtle hover:bg-canvas hover:text-ink sm:inline-flex" aria-label="Open" title="Open">
                <IconExternal size={16} />
              </a>
              {(a.uploaded_by?.id === me?.id || isAdmin) && (
                <button type="button" onClick={() => remove(a)} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${a.file_name}`}>
                  <IconTrash size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {uploading.length > 0 && (
        <ul className="border-t border-line/80 px-4 py-2 sm:px-5">
          {uploading.map((u, i) => (
            <li key={i} className={cn("flex items-center gap-2 py-1 text-xs", u.error ? "text-red-600" : "text-ink-muted")}>
              {u.done ? u.error ? "✕" : "✓" : <Spinner className="h-3 w-3" />}
              <span className="truncate">{u.name}</span>
              {u.error && <span className="truncate">— {u.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
