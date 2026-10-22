import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, serverError, readJsonObject } from "@/lib/api";
import { parseUuidList } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Mark notifications read: { ids: [...] } or { all: true }. Always scoped to
 * the caller's own rows. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const b = await readJsonObject(req);
  const now = new Date().toISOString();
  let q = getSupabase().from("notifications").update({ read_at: now }).eq("user_id", u.uid).is("read_at", null);
  if (b.all !== true) {
    const ids = parseUuidList(b.ids, 200);
    if (!ids || !ids.length) return ok();
    q = q.in("id", ids);
  }
  const { error } = await q;
  if (error) return serverError(error);
  return ok();
}
