import { getSupabase } from "./supabase";
import { USER_BRIEF_COLS, embeddedUser, embedded } from "./users";
import type { Meeting, MeetingSeries } from "./types";

export const MEETING_SELECT = `id, title, held_at, notes, status, finalized_at, created_at, series_id, app_ids, include_general, auto_close, series:meeting_series(id, name, color), creator:users!meetings_created_by_fkey(${USER_BRIEF_COLS}), meeting_notes(count)`;

export function shapeMeeting(r: Record<string, unknown>): Meeting {
  const counts = r.meeting_notes as { count: number }[] | undefined;
  return {
    id: r.id as string,
    title: r.title as string,
    held_at: r.held_at as string,
    notes: (r.notes as string | null) ?? null,
    status: r.status as Meeting["status"],
    finalized_at: (r.finalized_at as string | null) ?? null,
    created_at: r.created_at as string,
    created_by: embeddedUser(r.creator),
    note_count: counts?.[0]?.count ?? 0,
    auto_close: (r.auto_close as boolean | null) ?? null,
    series_id: (r.series_id as string | null) ?? null,
    series: embedded<{ id: string; name: string; color: string }>(r.series),
    app_ids: (r.app_ids as string[] | null) ?? [],
    include_general: (r.include_general as boolean | null) ?? true,
  };
}

export const SERIES_SELECT = "id, name, color, app_ids, include_general, app_order, auto_close, created_at";
export const SERIES_NAME_MAX = 60;

export function shapeSeries(r: Record<string, unknown>): MeetingSeries {
  return { id: r.id as string, name: r.name as string, color: r.color as string, app_ids: (r.app_ids as string[] | null) ?? [], include_general: (r.include_general as boolean | null) ?? true, app_order: (r.app_order as string[] | null) ?? [], auto_close: (r.auto_close as boolean | null) ?? true, created_at: r.created_at as string };
}

/** "Weekly sync · 21 Oct 2026" — the default title for a new meeting. */
export function defaultTitle(heldAt: Date, seriesName = "Weekly sync"): string {
  const d = heldAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  return `${seriesName} · ${d}`;
}

export async function loadMeeting(id: string) {
  const { data } = await getSupabase().from("meetings").select("id, title, held_at, status, created_by, series_id, app_ids").eq("id", id).maybeSingle();
  return data;
}

/** The series to use when a caller doesn't name one: the oldest, created on demand. */
export async function ensureDefaultSeries(createdBy: string | null): Promise<MeetingSeries> {
  const sb = getSupabase();
  const { data } = await sb.from("meeting_series").select(SERIES_SELECT).order("created_at").limit(1).maybeSingle();
  if (data) return shapeSeries(data as Record<string, unknown>);
  const { data: made, error } = await sb.from("meeting_series").insert({ name: "Weekly sync", created_by: createdBy }).select(SERIES_SELECT).single();
  if (error || !made) throw error ?? new Error("Couldn't create the default series");
  return shapeSeries(made as Record<string, unknown>);
}
