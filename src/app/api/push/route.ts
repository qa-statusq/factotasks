import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Is push configured, and does THIS browser have a subscription on file? */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  const enabled = !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
  let subscribed = false;
  if (enabled && endpoint) {
    const { data } = await getSupabase().from("push_subscriptions").select("id").eq("user_id", u.uid).eq("endpoint", endpoint).maybeSingle();
    subscribed = !!data;
  }
  const { count } = await getSupabase().from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", u.uid);
  return NextResponse.json({ enabled, subscribed, devices: count ?? 0 });
}

/** Browser push services only: the server POSTs to these URLs, so an
 * arbitrary endpoint would turn notifications into server-side requests. */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/i, /^fcm\.googleapis\.com$/i, /^android\.googleapis\.com$/i, /(^|\.)push\.services\.mozilla\.com$/i, /(^|\.)notify\.windows\.com$/i, /(^|\.)push\.samsungosp\.com$/i, /(^|\.)pushcenter\.hicloud\.com$/i];
const MAX_DEVICES = 10;

/** Save this browser's subscription: { endpoint, keys: { p256dh, auth } }. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const b = await readJsonObject(req);
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
  const keys = (b.keys && typeof b.keys === "object" ? b.keys : {}) as { p256dh?: unknown; auth?: unknown };
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return fail("Invalid subscription");
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return fail("Invalid subscription");
  }
  if (!PUSH_HOSTS.some((re) => re.test(host))) return fail("Unsupported push service");
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || keys.p256dh.length > 300 || keys.auth.length > 100) return fail("Invalid subscription keys");
  const ua = (req.headers.get("user-agent") || "").slice(0, 200) || null;
  const { count } = await getSupabase().from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", u.uid).neq("endpoint", endpoint);
  if ((count ?? 0) >= MAX_DEVICES) return fail(`Up to ${MAX_DEVICES} devices per person — turn notifications off on a device you no longer use`);
  const { error } = await getSupabase()
    .from("push_subscriptions")
    .upsert({ user_id: u.uid, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: ua, last_used: new Date().toISOString() }, { onConflict: "endpoint" });
  if (error) return serverError(error);
  return ok();
}

/** Remove this browser's subscription: { endpoint }. */
export async function DELETE(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const b = await readJsonObject(req);
  if (typeof b.endpoint !== "string") return fail("endpoint required");
  const { error } = await getSupabase().from("push_subscriptions").delete().eq("user_id", u.uid).eq("endpoint", b.endpoint);
  if (error) return serverError(error);
  return ok();
}
