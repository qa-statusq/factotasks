import { NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError, memberJson } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The whole dashboard in ONE round trip (dashboard_pack RPC). */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { data, error } = await getSupabase().rpc("dashboard_pack", { p_user: u.uid, p_admin: u.role === "admin" });
  if (error) return serverError(error);
  // dashboard_pack scopes everything to the caller (admins: all; members:
  // their apps) in SQL, so one round trip is the whole dashboard.
  return memberJson(u, data);
}
