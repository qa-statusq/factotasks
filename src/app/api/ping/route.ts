import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * The change counter (app_settings.rev, bumped by triggers on every content
 * table). The client polls this tiny row while a tab is visible and only
 * revalidates its screens when the number moves — live-ish updates for 50
 * people at the cost of one indexed primary-key read per poll.
 */
export async function GET() {
  // The counter is a harmless integer: a valid signature is enough, no users read per poll.
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await getSupabase().from("app_settings").select("value").eq("key", "rev").maybeSingle();
  return NextResponse.json({ rev: Number(data?.value ?? 0) });
}
