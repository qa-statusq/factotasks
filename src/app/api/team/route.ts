import { NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { visibleAppIds } from "@/lib/visibility";

export const dynamic = "force-dynamic";

/** Team directory with live workload per person (one RPC). Members see the
 * same roster; only admins see account-management facts (must-change flag). */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const [{ data, error }, allowed] = await Promise.all([getSupabase().rpc("team_overview"), visibleAppIds(u)]);
  if (error) return serverError(error);
  const rows = (data as Record<string, unknown>[]) || [];
  if (u.role === "admin") return NextResponse.json({ members: rows });
  // Members get the roster: names, departments and the apps they share with
  // the caller. Workload, sign-in facts and account state stay with admins.
  const mine = new Set(allowed ?? []);
  const members = rows.map(({ must_change_password: _mc, last_login_at: _ll, open: _o, in_progress: _ip, overdue: _od, done_week: _dw, email: _e, apps, ...rest }) => ({
    ...rest,
    apps: ((apps as { id: string }[]) || []).filter((a) => mine.has(a.id)),
  }));
  return NextResponse.json({ members });
}
