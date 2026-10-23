import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { istToday } from "@/lib/ist";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

function shiftDays(ymd: string, n: number): string {
  return new Date(Date.parse(ymd + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST days, at most 400 apart; default the
 * last six months). Throughput by period, cycle time, aging, per app, per
 * person, releases, meetings — one RPC.
 */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  const today = istToday();
  let to = sp.get("to") || today;
  let from = sp.get("from") || shiftDays(today, -182);
  if (!YMD.test(from) || !YMD.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) from = shiftDays(to, -MAX_DAYS);
  // Members get their own apps' analytics; admins the whole team.
  const { data, error } = await getSupabase().rpc("analytics_pack", { p_from: from, p_to: to, ...(u.role === "admin" ? {} : { p_user: u.uid }) });
  if (error) {
    // PGRST202 = function missing or still the old signature: migration 014 hasn't been run.
    // 424 (not 503) so the client cache treats it as final, not transient.
    if ((error as { code?: string }).code === "PGRST202") {
      return NextResponse.json({ error: "Analytics needs a database update — run supabase/migrations/014_app_order_analytics_range.sql in the Supabase SQL editor once." }, { status: 424 });
    }
    return serverError(error);
  }
  // Per-person throughput is a lead's view; members see apps, periods and mixes only.
  if (u.role !== "admin" && data && typeof data === "object") delete (data as Record<string, unknown>).by_person;
  return NextResponse.json(data);
}
