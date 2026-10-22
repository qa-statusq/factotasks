import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { decodeCursor, encodeCursor, tsIdKeysetDesc } from "@/lib/keyset";
import { isUuid } from "@/lib/validate";
import { displayName } from "@/lib/name";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/** Paginated audit feed (admin only). Filters: ?userId= ?action= ?entity=task:<id>.
 * Keyset (cursor) pagination — pass the previous response's nextCursor. */
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const userId = sp.get("userId");
  const action = (sp.get("action") || "").slice(0, 40);
  const entity = sp.get("entity") || "";
  const cursor = decodeCursor(sp.get("cursor"));

  let q = getSupabase()
    .from("activity_log")
    .select("id, user_email, action, entity_type, entity_id, summary, metadata, created_at, actor:users(first_name, last_name, color)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (isUuid(userId)) q = q.eq("user_id", userId!.toLowerCase());
  if (action) q = action.endsWith(".") ? q.like("action", `${action}%`) : q.eq("action", action);
  const [etype, eid] = entity.split(":");
  if (etype && eid) q = q.eq("entity_type", etype).eq("entity_id", eid);
  if (cursor?.c && cursor.i) q = q.or(tsIdKeysetDesc("created_at", { c: cursor.c, i: cursor.i }));

  const { data, error } = await q;
  if (error) return serverError(error);
  const all = (data || []) as unknown as Record<string, unknown>[];
  const hasMore = all.length > PAGE_SIZE;
  const rows = all.slice(0, PAGE_SIZE).map((r) => {
    const raw = r.actor as { first_name?: string | null; last_name?: string | null; color?: string }[] | { first_name?: string | null; last_name?: string | null; color?: string } | null;
    const actor = Array.isArray(raw) ? raw[0] : raw;
    const { actor: _drop, ...rest } = r;
    return { ...rest, user_name: displayName(actor?.first_name, actor?.last_name), user_color: actor?.color ?? null };
  });
  const last = rows[rows.length - 1] as { created_at?: string; id?: string } | undefined;
  const nextCursor = hasMore && last ? encodeCursor({ c: String(last.created_at), i: String(last.id) }) : null;
  return NextResponse.json({ activity: rows, hasMore, nextCursor });
}
