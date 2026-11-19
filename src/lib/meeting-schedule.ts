import { getSupabase } from "./supabase";
import { logActivity } from "./activity";
import { adminIds, notifyUsers } from "./notify";
import { closeOverdueMeetings } from "./series-access";
import { defaultTitle } from "./meetings";
import { istToday } from "./ist";

/**
 * Weekly meetings that create themselves (036). A series that repeats — say
 * every Thursday at 11:00 India time — gets its next meeting made ONE DAY
 * BEFORE: from Wednesday 00:00 IST, on the first run of either scheduled job
 * (the daily job at 09:00, the store check every 30 minutes), so Wednesday
 * morning it is there with its agenda.
 *
 * Exactly once per meeting day: the series' recur_last is claimed with a
 * conditional update BEFORE the meeting is inserted, so two runs at the same
 * moment can't both create it; if the insert then fails the claim is undone
 * and the next run tries again. A meeting already on that day in the series
 * (made by hand) counts as done. A series can have one open meeting at a
 * time: when the previous one is still open (it doesn't close by itself)
 * nothing is created and admins are told once.
 */
import { WEEKDAYS, addDays, istInstant, nextOccurrence } from "./recur";

export interface ScheduleResult {
  created: { series: string; meeting_id: string; held_at: string }[];
  skipped: { series: string; reason: string }[];
}

export async function createScheduledMeetings(now = new Date()): Promise<ScheduleResult> {
  const sb = getSupabase();
  const out: ScheduleResult = { created: [], skipped: [] };
  const { data: series, error } = await sb.from("meeting_series").select("id, name, app_ids, recur_weekday, recur_time, recur_last").not("recur_weekday", "is", null).not("recur_time", "is", null);
  if (error || !series?.length) return out; // nothing repeats (or 036 isn't run yet)
  // A meeting whose day is over closes first (when it is meant to), so the next one can open.
  await closeOverdueMeetings(true);
  const today = istToday();
  for (const s of series as { id: string; name: string; app_ids: string[]; recur_weekday: number; recur_time: string; recur_last: string | null }[]) {
    const day = nextOccurrence(s.recur_weekday, s.recur_time, now);
    if (addDays(day, -1) > today) continue; // not the day before yet
    if (s.recur_last && s.recur_last >= day) continue; // already made (or skipped) for that day
    const heldAt = istInstant(day, s.recur_time);
    // Made by hand already? Then that is this week's meeting.
    const dayStart = istInstant(day, "00:00").toISOString();
    const dayEnd = istInstant(addDays(day, 1), "00:00").toISOString();
    const { data: same } = await sb.from("meetings").select("id").eq("series_id", s.id).gte("held_at", dayStart).lt("held_at", dayEnd).limit(1).maybeSingle();
    if (same) {
      await sb.from("meeting_series").update({ recur_last: day }).eq("id", s.id);
      out.skipped.push({ series: s.name, reason: "a meeting on that day exists" });
      continue;
    }
    const { data: open } = await sb.from("meetings").select("id, title").eq("series_id", s.id).eq("status", "open").limit(1).maybeSingle();
    if (open) {
      // Told once per meeting day (the message names it).
      const message = `The ${s.name} meeting for ${day} wasn't created: “${open.title}” is still open — close it and it will be created on the next run`;
      const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("kind", "meeting.schedule").eq("message", message);
      if (!count) await notifyUsers({ userIds: await adminIds(), kind: "meeting.schedule", message, url: `/meetings/${open.id}` });
      out.skipped.push({ series: s.name, reason: "previous meeting still open" });
      continue;
    }
    // Claim the day first: only one run gets past this.
    let claim = sb.from("meeting_series").update({ recur_last: day }).eq("id", s.id);
    claim = s.recur_last ? claim.eq("recur_last", s.recur_last) : claim.is("recur_last", null);
    const { data: claimed } = await claim.select("id");
    if (!claimed?.length) continue;
    const { data: made, error: insErr } = await sb
      .from("meetings")
      .insert({ title: defaultTitle(heldAt, s.name), held_at: heldAt.toISOString(), created_by: null, series_id: s.id, app_ids: s.app_ids ?? [] })
      .select("id, title")
      .single();
    if (insErr || !made) {
      await sb.from("meeting_series").update({ recur_last: s.recur_last }).eq("id", s.id).eq("recur_last", day);
      out.skipped.push({ series: s.name, reason: insErr?.message ?? "insert failed" });
      continue;
    }
    out.created.push({ series: s.name, meeting_id: made.id as string, held_at: heldAt.toISOString() });
    await logActivity({ action: "meeting.create", entityType: "meeting", entityId: made.id as string, actor: { email: "Scheduler" }, summary: `Created meeting “${made.title}” (repeats every ${WEEKDAYS[s.recur_weekday - 1]} at ${s.recur_time})` });
  }
  return out;
}
