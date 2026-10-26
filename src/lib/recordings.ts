import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { USER_BRIEF_COLS, embedded, embeddedUser } from "@/lib/users";
import { fail } from "@/lib/api";
import type { Recording, RecordingShare } from "@/lib/types";

export const RECORDING_SELECT = `id, meeting_id, name, mime, size_bytes, duration_sec, status, drive_file_id, upload_uri, recorded_by, created_at, updated_at, recorder:users!meeting_recordings_recorded_by_fkey(${USER_BRIEF_COLS}), meeting:meetings(id, title, held_at, status, series:meeting_series(id, name, color))`;
export const SHARE_SELECT = `id, recording_id, email, permission_id, message, created_at, sharer:users!recording_shares_shared_by_fkey(${USER_BRIEF_COLS})`;

export interface RecordingRow extends Recording {
  upload_uri: string | null;
  recorded_by: string | null;
}

export function shapeRecording(r: Record<string, unknown>): RecordingRow {
  return {
    id: r.id as string,
    meeting_id: r.meeting_id as string,
    name: r.name as string,
    mime: r.mime as string,
    size_bytes: Number(r.size_bytes ?? 0),
    duration_sec: (r.duration_sec as number | null) ?? null,
    status: r.status as Recording["status"],
    drive_file_id: (r.drive_file_id as string | null) ?? null,
    upload_uri: (r.upload_uri as string | null) ?? null,
    recorded_by: (r.recorded_by as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    recorder: embeddedUser(r.recorder),
    meeting: shapeMeetingRef(r.meeting),
    shares: [],
  };
}

function shapeMeetingRef(v: unknown): Recording["meeting"] {
  const m = embedded<{ id: string; title: string; held_at: string; status: "open" | "finalized"; series?: unknown }>(v);
  if (!m) return null;
  return { id: m.id, title: m.title, held_at: m.held_at, status: m.status, series: embedded<{ id: string; name: string; color: string }>(m.series) ?? null };
}

/** The Drive file is "<meeting title> — Recording 2.webm"; the panel shows "Recording 2". */
export function recordingLabel(r: Pick<Recording, "name" | "meeting">): string {
  let base = r.name.replace(/\.(webm|weba|mp4|m4a|mkv|ogg)$/i, "");
  const title = r.meeting?.title;
  if (title && base.startsWith(`${title} — `)) base = base.slice(title.length + 3);
  return base || "Recording";
}

/** The file name on Drive for a panel label. */
export function recordingFileName(title: string | null | undefined, label: string, ext: string): string {
  return `${title ? `${title} — ` : ""}${label}${ext}`;
}

export function shapeShare(r: Record<string, unknown>): RecordingShare {
  return {
    id: r.id as string,
    email: r.email as string,
    message: (r.message as string | null) ?? null,
    created_at: r.created_at as string,
    sharer: embeddedUser(r.sharer),
  };
}

/** What the panel shows: never the upload session. */
export function publicRecording(r: RecordingRow): Recording {
  const { upload_uri: _u, recorded_by: _b, ...rest } = r;
  void _u;
  void _b;
  return rest;
}

export async function loadRecording(id: string): Promise<RecordingRow | null> {
  const { data } = await getSupabase().from("meeting_recordings").select(RECORDING_SELECT).eq("id", id).maybeSingle();
  return data ? shapeRecording(data as unknown as Record<string, unknown>) : null;
}

export async function loadShares(recordingId: string): Promise<RecordingShare[]> {
  const { data } = await getSupabase().from("recording_shares").select(SHARE_SELECT).eq("recording_id", recordingId).order("created_at", { ascending: true });
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(shapeShare);
}

/** Only admins manage a recording (rename, share, delete); the people of its series watch it. */
export function canManage(u: { uid: string; role: string }, _r: RecordingRow): boolean {
  void _r;
  return u.role === "admin";
}

/** Who may push bytes into a recording's upload: an admin, or whoever started it. */
export function canUpload(u: { uid: string; role: string }, r: RecordingRow): boolean {
  return u.role === "admin" || r.recorded_by === u.uid;
}

/** True until migration 019 has been applied (Postgres 42P01, or PostgREST's schema-cache miss). */
export function missingTable(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || /schema cache/i.test(e.message ?? ""));
}

export function notConfigured(): NextResponse {
  return fail("Recording isn't set up on this server yet", 503);
}

/** Bytes → "412 MB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Seconds → "00:12:34" (always hours, for the live recording clock). */
export function fmtClock(s: number | null | undefined): string {
  const n = Math.max(0, Math.floor(s ?? 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = n % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Seconds → "1:02:35" or "12:07". */
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
