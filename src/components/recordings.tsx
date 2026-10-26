"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { istTime } from "@/lib/time";
import { fmtBytes, fmtDuration, recordingLabel } from "@/lib/recordings";
import { cn } from "@/lib/cn";
import { IconPlay, IconDownload, IconSend, IconTrash, IconEdit, IconX, IconMic, IconVideo } from "@/components/ui/icons";
import type { Recording, RecordingShare } from "@/lib/types";

/** The recordings of one meeting (sidebar card) or of every meeting (the Recordings screen). */
export function RecordingList({ recordings, cacheKey, showMeeting, emptyText }: { recordings: Recording[]; cacheKey: string; showMeeting?: boolean; emptyText?: string }) {
  const { isAdmin } = useSession();
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [sharing, setSharing] = useState<Recording | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const shown = recordings.filter((r) => !gone.has(r.id));
  if (!shown.length) return emptyText ? <p className="text-[12px] text-ink-subtle">{emptyText}</p> : null;
  return (
    <>
      <ul className="flex flex-col divide-y divide-line/70">
        {shown.map((r) => (
          <RecordingRow key={r.id} r={r} cacheKey={cacheKey} showMeeting={showMeeting} canManage={isAdmin} onPlay={() => setPlaying(r)} onShare={() => setSharing(r)} onGone={(back) => setGone((prev) => { const n = new Set(prev); if (back) n.delete(r.id); else n.add(r.id); return n; })} />
        ))}
      </ul>
      {playing && <PlayerSheet r={playing} onClose={() => setPlaying(null)} />}
      {sharing && <ShareSheet r={sharing} cacheKey={cacheKey} onClose={() => setSharing(null)} />}
    </>
  );
}

function RecordingRow({ r, cacheKey, showMeeting, canManage, onPlay, onShare, onGone }: { r: Recording; cacheKey: string; showMeeting?: boolean; canManage: boolean; onPlay: () => void; onShare: () => void; onGone: (back: boolean) => void }) {
  const { toast } = useToast();
  const { confirm, prompt } = useDialog();
  const [busy, setBusy] = useState(false);
  const ready = r.status === "ready";

  async function rename() {
    const base = recordingLabel(r);
    const name = await prompt({ title: "Rename recording", defaultValue: base, confirmLabel: "Rename" });
    if (!name || name.trim() === base) return;
    setBusy(true);
    const { ok, data } = await postJson(`/api/recordings/${r.id}`, { name: name.trim() }, "PATCH");
    setBusy(false);
    if (ok) {
      mutate(cacheKey);
      mutatePrefix("/api/recordings");
      toast("Renamed");
    } else toast(data?.error || "Couldn't rename", "error");
  }
  async function remove() {
    if (!(await confirm({ title: "Delete this recording?", message: "It disappears from the panel, and people it was shared with lose access.", confirmLabel: "Delete", tone: "danger" }))) return;
    // The row goes at once; Google moves the file to the bin in the background and the row only returns if that fails.
    onGone(false);
    toast("Recording deleted");
    const { ok, data } = await deleteJson(`/api/recordings/${r.id}`);
    if (ok) {
      mutate(cacheKey);
      mutatePrefix("/api/recordings");
    } else {
      onGone(true);
      toast(data?.error || "Couldn't delete the recording", "error");
    }
  }

  return (
    <li className="group flex items-start gap-3 py-2.5">
      <button type="button" onClick={onPlay} disabled={!ready} className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", ready ? "bg-ink text-white hover:bg-black" : "bg-canvas text-ink-subtle")} aria-label={ready ? "Play" : r.status === "uploading" ? "Still recording" : "Upload failed"} title={ready ? "Play" : r.status === "uploading" ? "Still recording" : "Upload failed"}>
        {ready ? <IconPlay size={15} /> : r.status === "uploading" ? <Spinner className="h-4 w-4" /> : <IconX size={15} />}
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onPlay} disabled={!ready} className="flex max-w-full items-center gap-1.5 truncate text-left text-[13.5px] font-medium text-ink hover:text-brand-700 disabled:text-ink-muted">
          {isAudioRecording(r) ? <IconMic size={13} className="shrink-0 text-ink-subtle" /> : <IconVideo size={13} className="shrink-0 text-ink-subtle" />}
          <span className="truncate">{recordingLabel(r)}</span>
        </button>
        {showMeeting && r.meeting && (
          <Link href={`/meetings/${r.meeting.id}`} className="block truncate text-[12px] text-ink-muted hover:text-ink">
            {r.meeting.title}
          </Link>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-subtle">
          <span className="tabular-nums">{fmtDuration(r.duration_sec)}</span>
          <span>·</span>
          <span className="tabular-nums">{fmtBytes(r.size_bytes)}</span>
          {r.status !== "ready" && (
            <>
              <span>·</span>
              <span className={r.status === "failed" ? "font-semibold text-red-600" : "font-semibold text-amber-700"}>{r.status === "failed" ? "Upload failed" : "In progress…"}</span>
            </>
          )}
          <span>·</span>
          <span title={istTime(r.created_at)}>{timeOfDay(r.created_at)}</span>
          {r.recorder && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Avatar user={r.recorder} size="xs" /> {r.recorder.name}
              </span>
            </>
          )}
        </div>
        {ready && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {canManage && (
              <a href={`/api/recordings/${r.id}/stream?download=1`} className={buttonClass("secondary", "sm", "h-7 px-2 text-[12px]")} download={r.name}>
                <IconDownload size={13} /> Download
              </a>
            )}
            {canManage && (
              <>
                <Button variant="secondary" size="sm" onClick={onShare} className="h-7 px-2 text-[12px]">
                  <IconSend size={13} /> Share
                </Button>
                <button type="button" onClick={rename} disabled={busy} className="rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label="Rename" title="Rename">
                  <IconEdit size={14} />
                </button>
                <button type="button" onClick={remove} disabled={busy} className="rounded-md p-1 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label="Delete" title="Delete">
                  <IconTrash size={14} />
                </button>
              </>
            )}
          </div>
        )}
        {!ready && canManage && (
          <div className="mt-1.5">
            <button type="button" onClick={remove} disabled={busy} className="text-[12px] font-medium text-ink-subtle hover:text-red-600">
              Remove
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export const isAudioRecording = (r: Pick<Recording, "mime">) => r.mime.startsWith("audio/");

/** Inline player — the file streams through the panel, no Google sign-in. */
export function PlayerSheet({ r, onClose }: { r: Recording; onClose: () => void }) {
  const { isAdmin } = useSession();
  return (
    <Sheet title={r.meeting ? r.meeting.title : recordingLabel(r)} description={`${recordingLabel(r)} · ${fmtDuration(r.duration_sec)} · ${fmtBytes(r.size_bytes)}`} onClose={onClose} wide
      footer={
        <div className="flex items-center justify-end gap-2">
          {isAdmin && (
            <a href={`/api/recordings/${r.id}/stream?download=1`} className={buttonClass("secondary", "sm")} download={r.name}>
              <IconDownload size={14} /> Download
            </a>
          )}
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      {isAudioRecording(r) ? (
        <div className="flex flex-col items-center gap-4 rounded-lg bg-canvas px-4 py-8">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-white">
            <IconMic size={24} />
          </span>
          <audio src={`/api/recordings/${r.id}/stream`} controls autoPlay preload="metadata" className="w-full" />
        </div>
      ) : (
        <video src={`/api/recordings/${r.id}/stream`} controls autoPlay playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black" />
      )}
    </Sheet>
  );
}

/** Share with e-mail addresses: Google sends each one an invitation to the Drive file. */
function ShareSheet({ r, cacheKey, onClose }: { r: Recording; cacheKey: string; onClose: () => void }) {
  const { toast } = useToast();
  const key = `/api/recordings/${r.id}`;
  const { data, refresh } = useCachedFetch<{ recording: Recording & { shares: RecordingShare[] } }>(key);
  const shares = data?.recording.shares ?? [];
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!emails.trim() || busy) return;
    setBusy(true);
    const { ok, data: d } = await postJson<{ added?: string[]; failed?: { email: string; error: string }[]; error?: string }>(`/api/recordings/${r.id}/shares`, { emails, message: message.trim() || null });
    setBusy(false);
    if (!ok) return toast(d?.error || "Couldn't share", "error");
    refresh();
    mutate(cacheKey);
    setEmails("");
    if (d?.failed?.length) toast(`Shared with ${d.added?.length ?? 0}; failed: ${d.failed.map((f) => f.email).join(", ")}`, "error");
    else toast(d?.added?.length ? `Shared with ${d.added.join(", ")}` : "Already shared with everyone listed");
  }
  async function revoke(s: RecordingShare) {
    // The row goes at once; the access is removed in the background and the row only comes back if that fails.
    setRemoving((prev) => new Set(prev).add(s.id));
    if (data) mutate(key, { recording: { ...data.recording, shares: data.recording.shares.filter((x) => x.id !== s.id) } });
    toast(`Access removed for ${s.email}`);
    const { ok, data: d } = await deleteJson(`/api/recordings/${r.id}/shares?share=${s.id}`);
    setRemoving((prev) => {
      const n = new Set(prev);
      n.delete(s.id);
      return n;
    });
    if (!ok) {
      refresh();
      toast(d?.error || `Couldn't remove access for ${s.email}`, "error");
    }
  }

  return (
    <Sheet title="Share recording" description={`${r.meeting ? `${r.meeting.title} · ` : ""}${recordingLabel(r)} — each address gets an e-mail with a link to watch it.`} onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={send} disabled={busy || !emails.trim()}>
            {busy ? <Spinner /> : <IconSend size={14} />} Share
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12.5px] font-medium text-ink">
          E-mail addresses
          <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@company.com, another@company.com" inputMode="email" autoFocus className="h-9 text-[13px]" />
          <span className="text-[11.5px] font-normal text-ink-subtle">Up to 10 at a time, separated by commas.</span>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-medium text-ink">
          Message <span className="font-normal text-ink-subtle">(optional, goes in the e-mail)</span>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={1000} placeholder="Recording of this week's mobile apps meeting." className="text-[13px]" />
        </label>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">Has access</p>
          {shares.length ? (
            <ul className="divide-y divide-line/70 rounded-lg border border-line">
              {shares.filter((s) => !removing.has(s.id)).map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{s.email}</span>
                  <span className="text-[11.5px] text-ink-subtle" title={istTime(s.created_at)}>
                    {istTime(s.created_at).replace(/, \d\d:\d\d(:\d\d)? (am|pm) IST$/, "")}
                  </span>
                  <button type="button" onClick={() => revoke(s)} className="rounded-md p-1 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove access for ${s.email}`} title="Remove access">
                    <IconX size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-subtle">Nobody outside the panel yet. Team members watch it here without any sharing.</p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Sidebar card on the meeting page: this meeting's recordings. */
export function MeetingRecordingsCard({ meetingId }: { meetingId: string }) {
  const key = `/api/meetings/${meetingId}/recordings`;
  const { data } = useCachedFetch<{ recordings: Recording[]; enabled: boolean; migration?: string }>(key);
  const list = data?.recordings ?? [];
  return (
    <section id="recordings" className="rounded-xl border border-line bg-surface p-4 scroll-mt-20">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
        Recordings
        {list.length > 0 && <span className="rounded-full bg-canvas px-1.5 text-[11px] font-medium tabular-nums text-ink-muted">{list.length}</span>}
        <Link href="/recordings" className="ml-auto text-[11.5px] font-medium text-ink-subtle hover:text-ink">All recordings</Link>
      </h2>
      <RecordingList recordings={list} cacheKey={key} emptyText={data?.migration ? `Database migration ${data.migration} hasn't been run yet.` : data && !data.enabled ? "Recording isn't set up on this server yet." : "None yet. Use Record meeting above, or the record button while presenting."} />
    </section>
  );
}

/** "12:05 pm" — the day is already on the meeting. */
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME_FMT.format(d);
}
