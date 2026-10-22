import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

/** ?months=6 (1–24). Month-wise throughput, per app, per person, status mix. */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const months = Math.min(24, Math.max(1, Number(new URL(req.url).searchParams.get("months")) || 6));
  // Members get their own apps' analytics; admins the whole team.
  const { data, error } = await getSupabase().rpc("analytics_pack", { p_months: months, ...(u.role === "admin" ? {} : { p_user: u.uid }) });
  if (error) {
    // PGRST202 = function missing: schema.sql hasn't been re-run since analytics landed.
    // 424 (not 503) so the client cache treats it as final, not transient.
    if ((error as { code?: string }).code === "PGRST202") {
      return NextResponse.json({ error: "Analytics needs a database update — run supabase/schema.sql in the Supabase SQL editor once." }, { status: 424 });
    }
    return serverError(error);
  }
  // Per-person throughput is a lead's view; members see apps, months and status mix only.
  if (u.role !== "admin" && data && typeof data === "object") delete (data as Record<string, unknown>).by_person;
  return NextResponse.json(data);
}
