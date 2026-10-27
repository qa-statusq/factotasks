import { NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { visibleAppIds, NONE_ID } from "@/lib/visibility";

export const dynamic = "force-dynamic";

/**
 * Work in progress that no release carries yet, per app and platform — exactly
 * what the "not in any release yet" banner needs (ids and numbers), instead of
 * up to 200 whole task cards on every Dashboard and Releases visit.
 * Members: only targets on their own apps.
 */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  let q = getSupabase()
    .from("task_targets")
    .select("app_id, platform, task:tasks!inner(id, number, status)")
    .is("release_id", null)
    .is("released_at", null)
    .in("task.status", ["in_progress", "in_review", "partial"])
    .limit(1000);
  const allowed = await visibleAppIds(u);
  if (allowed !== null) q = q.in("app_id", allowed.length ? allowed : [NONE_ID]);
  const { data, error } = await q;
  if (error) return serverError(error);
  const groups = new Map<string, { app_id: string; platform: "android" | "ios"; tasks: { id: string; number: number }[] }>();
  for (const r of data || []) {
    const t = (Array.isArray(r.task) ? r.task[0] : r.task) as { id: string; number: number } | null;
    if (!t) continue;
    const k = `${r.app_id}:${r.platform}`;
    const g = groups.get(k) ?? { app_id: r.app_id as string, platform: r.platform as "android" | "ios", tasks: [] };
    if (!g.tasks.some((x) => x.id === t.id)) g.tasks.push({ id: t.id, number: t.number });
    groups.set(k, g);
  }
  return NextResponse.json({ groups: [...groups.values()].sort((a, b) => b.tasks.length - a.tasks.length) });
}
