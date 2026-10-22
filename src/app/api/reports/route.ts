import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError } from "@/lib/api";
import { isYmd, istToday } from "@/lib/ist";

export const dynamic = "force-dynamic";

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST days, default: last 30 days, max 366). */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") || istToday();
  const from = sp.get("from") || new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!isYmd(from) || !isYmd(to)) return fail("Dates must be YYYY-MM-DD");
  if (from > to) return fail("“from” must not be after “to”");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return fail("Pick a range of at most one year");
  // Members get their own apps' figures and no per-person breakdown.
  const { data, error } = await getSupabase().rpc("report_pack", { p_from: from, p_to: to, ...(u.role === "admin" ? {} : { p_user: u.uid }) });
  if (error) return serverError(error);
  return NextResponse.json(data);
}
