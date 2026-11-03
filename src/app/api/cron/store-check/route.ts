import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { safeEqual } from "@/lib/password";
import { runStoreCheck } from "@/lib/store-check";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Store check, called by Cloud Scheduler every 30 minutes with `Authorization:
 * Bearer <CRON_SECRET>` (see DEPLOY.md). A version that isn't released yet but
 * is already live on Google Play / the App Store is marked released, dated when
 * the store published it. With no version pending, no store is contacted.
 * `?dry=1` reports what it would do and changes nothing.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.CRON_SECRET || !safeEqual(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  if (!dryRun) {
    // One run at a time: a scheduler retry must not release (and announce) a version twice.
    const { data: lease } = await getSupabase().rpc("cron_lease", { p_name: "store-check", p_ttl_sec: 600 });
    if (lease === false) return NextResponse.json({ ok: true, skipped: "another run is in progress" });
  }
  try {
    const result = await runStoreCheck({ dryRun });
    return NextResponse.json({ ok: true, dryRun, ...result });
  } catch (e) {
    console.error("[cron] store check:", e);
    return NextResponse.json({ error: "Store check failed" }, { status: 500 });
  }
}
