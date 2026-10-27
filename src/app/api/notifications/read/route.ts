import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError, readJsonObject } from "@/lib/api";
import { isUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Mark notifications read: { task_id } (opening a task reads what was about it)
 * or { all: true }. Always scoped to the caller's own rows; answers how many changed. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const b = await readJsonObject(req);
  const now = new Date().toISOString();
  let q = getSupabase().from("notifications").update({ read_at: now }).eq("user_id", u.uid).is("read_at", null);
  if (b.all !== true) {
    if (!isUuid(b.task_id)) return NextResponse.json({ ok: true, updated: 0 });
    q = q.eq("task_id", String(b.task_id).toLowerCase());
  }
  const { data, error } = await q.select("id");
  if (error) return serverError(error);
  return NextResponse.json({ ok: true, updated: data?.length ?? 0 });
}
