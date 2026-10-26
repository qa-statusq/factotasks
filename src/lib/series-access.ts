import { getSupabase } from "@/lib/supabase";
import { istDayKey, istToday } from "@/lib/ist";
import { logActivity } from "@/lib/activity";
import type { SessionUser } from "@/lib/auth";

/**
 * Who may look at a meeting: admins, and the people added to its series.
 * A series member gets the meetings of that series (and their recordings)
 * read-mostly: present, print, record, add a task, move their own tasks.
 */

/** The series this person has been added to (empty for admins' purposes: they see everything anyway). */
export async function memberSeriesIds(uid: string): Promise<string[]> {
  const { data, error } = await getSupabase().from("meeting_series_members").select("series_id").eq("user_id", uid);
  if (error) {
    console.error("[series] members lookup failed:", error);
    return [];
  }
  return (data ?? []).map((r) => r.series_id as string);
}

export async function canAccessMeeting(u: Pick<SessionUser, "uid" | "role">, m: { series_id?: string | null }): Promise<boolean> {
  if (u.role === "admin") return true;
  if (!m.series_id) return false;
  return (await memberSeriesIds(u.uid)).includes(m.series_id);
}

export async function canAccessSeries(u: Pick<SessionUser, "uid" | "role">, seriesId: string | null | undefined): Promise<boolean> {
  if (u.role === "admin") return true;
  if (!seriesId) return false;
  return (await memberSeriesIds(u.uid)).includes(seriesId);
}

/**
 * Close a meeting: freeze the scope it ran with (while open it follows its
 * series) and stamp the time. Shared by "Close meeting" and the automatic
 * close at the end of the meeting's day.
 */
export async function finalizeMeeting(id: string, extra: Record<string, unknown> = {}): Promise<{ error: { message: string } | null }> {
  const sb = getSupabase();
  const { data: cur } = await sb.from("meetings").select("id, series_id, status").eq("id", id).maybeSingle();
  if (!cur || cur.status === "finalized") return { error: null };
  const patch: Record<string, unknown> = { ...extra, status: "finalized", finalized_at: new Date().toISOString() };
  if (cur.series_id && !("app_ids" in patch)) {
    const { data: ser } = await sb.from("meeting_series").select("app_ids, include_general").eq("id", cur.series_id as string).maybeSingle();
    if (ser) {
      patch.app_ids = ser.app_ids ?? [];
      patch.include_general = ser.include_general ?? true;
    }
  }
  const { error } = await sb.from("meetings").update(patch).eq("id", id);
  return { error };
}

let lastSweep = 0;
/**
 * Meetings whose day (India) has ended close by themselves when their
 * series — or the meeting itself — says so. Runs at most once a minute,
 * from the meeting lists and the daily job, so it needs no scheduler to
 * be right. Returns how many were closed.
 */
export async function closeOverdueMeetings(force = false): Promise<number> {
  if (!force && Date.now() - lastSweep < 60_000) return 0;
  lastSweep = Date.now();
  const sb = getSupabase();
  const { data, error } = await sb.from("meetings").select("id, title, held_at, auto_close, series:meeting_series(auto_close)").eq("status", "open").limit(200);
  if (error || !data) {
    if (error) console.error("[meetings] auto-close sweep failed:", error);
    return 0;
  }
  const today = istToday();
  let closed = 0;
  for (const m of data as { id: string; title: string; held_at: string; auto_close: boolean | null; series: { auto_close?: boolean } | { auto_close?: boolean }[] | null }[]) {
    if (istDayKey(m.held_at) >= today) continue; // its day is not over yet
    const s = Array.isArray(m.series) ? m.series[0] : m.series;
    const wants = m.auto_close ?? s?.auto_close ?? true;
    if (!wants) continue;
    const { error: e } = await finalizeMeeting(m.id);
    if (e) continue;
    closed++;
    await logActivity({ action: "meeting.update", entityType: "meeting", entityId: m.id, summary: `Closed meeting “${m.title}” automatically at the end of its day` });
  }
  return closed;
}
