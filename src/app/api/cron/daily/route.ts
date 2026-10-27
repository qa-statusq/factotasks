import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { safeEqual } from "@/lib/password";
import { purgeOldActivity, logActivity } from "@/lib/activity";
import { notifyUsers, purgeOldNotifications } from "@/lib/notify";
import { istDayStartUtc, istToday } from "@/lib/ist";
import { taskRef } from "@/lib/domain";
import { closeOverdueMeetings } from "@/lib/series-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily housekeeping, called by Cloud Scheduler with `Authorization: Bearer
 * <CRON_SECRET>` (see DEPLOY.md). Idempotent for a given day:
 *  - "due tomorrow" / "overdue" reminders to assignees (one per task per day)
 *  - trims the activity log (14 d) and notifications (60 d)
 * Rejects any request without the secret — safe to expose publicly.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.CRON_SECRET || !safeEqual(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sb = getSupabase();
  // One run at a time: a scheduler retry or a second instance must not send every reminder twice.
  const { data: lease } = await sb.rpc("cron_lease", { p_name: "daily", p_ttl_sec: 3600 });
  if (lease === false) return NextResponse.json({ ok: true, skipped: "another run is in progress" });
  const today = istToday();
  await closeOverdueMeetings(true);
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);

  // Open tasks due tomorrow or already overdue, with their assignees.
  const { data: tasks, error } = await sb
    .from("tasks")
    .select("id, number, title, due_date, app_id, task_assignees(user_id), app:apps(status)")
    .in("status", ["todo", "in_progress", "in_review", "on_hold", "partial"])
    .not("due_date", "is", null)
    .lte("due_date", tomorrow)
    .limit(500);
  if (error) return NextResponse.json({ error: "Could not read tasks" }, { status: 500 });

  // Skip tasks already reminded today (kind task.due, created today IST).
  const dayStart = istDayStartUtc(today);
  const { data: already } = await sb.from("notifications").select("task_id").eq("kind", "task.due").gte("created_at", dayStart).limit(5000);
  const done = new Set((already || []).map((r) => r.task_id as string));

  // Overdue nags taper: days 1, 2, 3, 7, 14, then every 7 days — not every morning forever.
  const daysLate = (due: string) => Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000);
  const nagToday = (late: number) => late <= 3 || late === 7 || late === 14 || (late > 14 && late % 7 === 0);
  const jobs: (() => Promise<void>)[] = [];
  for (const t of tasks || []) {
    if (done.has(t.id as string)) continue;
    const app = (Array.isArray(t.app) ? t.app[0] : t.app) as { status?: string } | null;
    if (app?.status === "archived") continue;
    const assignees = ((t.task_assignees as { user_id: string }[] | null) || []).map((a) => a.user_id);
    if (!assignees.length) continue;
    const due = t.due_date as string;
    if (due < today && !nagToday(daysLate(due))) continue;
    const msg = due < today ? `${taskRef(t.number as number)} “${t.title}” is overdue (was due ${due})` : due === today ? `${taskRef(t.number as number)} “${t.title}” is due today` : `${taskRef(t.number as number)} “${t.title}” is due tomorrow`;
    jobs.push(() => notifyUsers({ userIds: assignees, kind: "task.due", taskId: t.id as string, message: msg }));
  }
  let reminders = jobs.length;
  const worker = async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) {
      try {
        await j();
      } catch {
        reminders--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, worker));

  await Promise.all([purgeOldActivity(90), purgeOldNotifications(60)]);
  await logActivity({ action: "cron.daily", actor: { email: "system" }, summary: `Daily job: ${reminders} due-date reminder(s), old activity/notifications trimmed` });
  return NextResponse.json({ ok: true, reminders });
}
