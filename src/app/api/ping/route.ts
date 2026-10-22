import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * The change counter (app_settings.rev, bumped by triggers on every content
 * table). The client polls this tiny row while a tab is visible and only
 * revalidates its screens when the number moves — live-ish updates for 50
 * people at the cost of one indexed primary-key read per poll.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const { data } = await getSupabase().from("app_settings").select("value").eq("key", "rev").maybeSingle();
  return NextResponse.json({ rev: Number(data?.value ?? 0) });
}
