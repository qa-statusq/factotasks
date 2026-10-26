import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError, memberJson } from "@/lib/api";
import { isUuid, oneOf, parseDate } from "@/lib/validate";
import { RELEASE_SELECT_FULL, shapeRelease } from "@/lib/releases";
import { releaseDay } from "@/lib/release-day";
import { displayName } from "@/lib/name";
import { visibleAppIds, NONE_ID } from "@/lib/visibility";

export const dynamic = "force-dynamic";

export interface ReleaseEvent {
  id: string;
  release_id: string;
  action: string;
  summary: string | null;
  by: string;
  created_at: string;
  /** Field-level diff when the change recorded one: { planned_date: { from, to }, status: {…}, … } */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  closed?: number;
}

/**
 * Every release with its full audit trail, for the history view.
 * ?app=<uuid> ?platform=android|ios ?from=YYYY-MM-DD ?to=YYYY-MM-DD
 * The date window matches a release by its released date, else its planned
 * date, else when it was created — so a planned version is never invisible.
 */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  const sb = getSupabase();
  let q = sb.from("releases").select(RELEASE_SELECT_FULL).order("created_at", { ascending: false }).limit(500);
  const app = sp.get("app");
  if (isUuid(app)) q = q.eq("app_id", app!.toLowerCase());
  const allowed = await visibleAppIds(u);
  if (allowed !== null) q = q.in("app_id", allowed.length ? allowed : [NONE_ID]);
  const platform = oneOf(sp.get("platform"), ["android", "ios"] as const);
  if (platform) q = q.eq("platform", platform);
  const { data, error } = await q;
  if (error) return serverError(error);
  const from = parseDate(sp.get("from"));
  const to = parseDate(sp.get("to"));
  const releases = ((data as unknown as Record<string, unknown>[]) || []).map(shapeRelease).filter((r) => {
    const d = releaseDay(r);
    return (!from || d >= from) && (!to || d <= to);
  });

  const ids = releases.map((r) => r.id);
  let events: ReleaseEvent[] = [];
  if (ids.length) {
    const { data: log, error: e2 } = await sb.from("activity_log").select("id, entity_id, action, summary, user_id, user_email, metadata, created_at").eq("entity_type", "release").in("entity_id", ids).order("created_at", { ascending: true }).limit(5000);
    if (e2) return serverError(e2);
    // Who did it, by name. The address is the fallback for admins only.
    const actorIds = [...new Set((log || []).map((r) => r.user_id as string | null).filter((x): x is string => !!x))];
    const { data: people } = actorIds.length ? await sb.from("users").select("id, first_name, last_name").in("id", actorIds) : { data: [] as { id: string; first_name: string | null; last_name: string | null }[] };
    const nameOf = new Map((people || []).map((p) => [p.id as string, displayName(p.first_name as string | null, p.last_name as string | null)]));
    events = (log || []).map((r) => {
      const md = (r.metadata ?? null) as { changes?: Record<string, { from: unknown; to: unknown }>; closed?: number } | null;
      const name = (r.user_id && nameOf.get(r.user_id as string)) || (u.role === "admin" ? ((r.user_email as string) || "system").split("@")[0] : "Teammate");
      return { id: r.id as string, release_id: r.entity_id as string, action: r.action as string, summary: (r.summary as string | null) ?? null, by: name, created_at: r.created_at as string, changes: md?.changes ?? null, closed: md?.closed };
    });
  }
  return memberJson(u, { releases, events });
}
