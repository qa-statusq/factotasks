import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { USER_BRIEF_COLS, embedded, embeddedUser } from "@/lib/users";

export const dynamic = "force-dynamic";

/**
 * ?limit=N (1-50). Returns { unread, approvals, notifications }. The shell
 * calls this with limit=1 as its ONE badge feed (inbox dot, approvals badge,
 * tab-title prefix); the Inbox screen uses limit=30 (+ ?before= cursor).
 */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 30));
  const before = sp.get("before");
  const sb = getSupabase();

  let list = sb
    .from("notifications")
    .select(`id, kind, task_id, message, read_at, created_at, actor:users!notifications_actor_id_fkey(${USER_BRIEF_COLS}), task:tasks(id, number, title)`)
    .eq("user_id", u.uid)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  const beforeId = sp.get("before_id");
  if (before && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(before)) {
    // Keyset on (created_at, id): rows sharing the boundary instant still page.
    if (beforeId && /^[0-9a-f-]{36}$/i.test(beforeId)) list = list.or(`created_at.lt."${before}",and(created_at.eq."${before}",id.lt."${beforeId}")`);
    else list = list.lt("created_at", before);
  }

  const [unreadRes, approvalsRes, releaseReqRes, listRes] = await Promise.all([
    sb.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", u.uid).is("read_at", null),
    u.role === "admin" ? sb.from("tasks").select("id", { count: "exact", head: true }).not("requested_status", "is", null) : Promise.resolve({ count: 0, error: null }),
    u.role === "admin" ? sb.from("releases").select("id", { count: "exact", head: true }).not("requested_status", "is", null) : Promise.resolve({ count: 0, error: null }),
    list,
  ]);
  if (listRes.error) return serverError(listRes.error);
  const rows = (listRes.data || []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const notifications = rows.slice(0, limit).map((r) => ({
    id: r.id,
    kind: r.kind,
    task_id: r.task_id ?? null,
    message: r.message,
    read_at: r.read_at ?? null,
    created_at: r.created_at,
    actor: embeddedUser(r.actor),
    task: embedded<{ id: string; number: number; title: string }>(r.task),
  }));
  return NextResponse.json({
    unread: unreadRes.count ?? 0,
    approvals: (approvalsRes.count ?? 0) + (releaseReqRes.count ?? 0),
    notifications,
    hasMore,
  });
}
