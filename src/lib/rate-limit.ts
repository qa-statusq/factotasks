import { NextResponse } from "next/server";
import { getSupabase } from "./supabase";

/**
 * Best-effort fixed-window rate limit for expensive endpoints (AI generation,
 * sync). Reuses the existing `auth_throttle` table — no new infra, zero cost —
 * with `rl:` keys that never collide with the login throttle's `email:`/`ip:`
 * keys. Protects the free AI quota and the app from a logged-in user hammering
 * these routes.
 *
 * Fail-OPEN: any error talking to the throttle store returns "allowed" so a
 * transient hiccup never blocks a legitimate user. The read-then-write counter
 * isn't strictly atomic, which is fine here — the goal is abuse mitigation, not
 * exact accounting, and a small over-count under burst concurrency is harmless.
 *
 * Returns a ready-to-return 429 NextResponse when over the limit, else null.
 */
export async function rateLimited(
  identity: string,
  action: string,
  max: number,
  windowSec: number
): Promise<NextResponse | null> {
  try {
    const sb = getSupabase();
    const now = Date.now();
    const bucket = Math.floor(now / (windowSec * 1000)); // fixed window
    const key = `rl:${action}:${identity}:${bucket}`;

    // ONE round trip (throttle_hit RPC): atomically increment the counter and get
    // its new value. `used` = this call's count (post-increment).
    let used: number;
    const { data, error } = await sb.rpc("throttle_hit", { p_key: key });
    if (!error && typeof data === "number") {
      used = data;
    } else {
      // Fallback for before 040 is applied (RPC missing): the original
      // non-atomic select-then-upsert. Same effective limit.
      const { data: row } = await sb.from("auth_throttle").select("fails").eq("key", key).maybeSingle();
      used = ((row?.fails as number | undefined) ?? 0) + 1;
      await sb
        .from("auth_throttle")
        .upsert({ key, fails: used, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    // Blocks the (max+1)th call in the window; both paths allow exactly `max`.
    if (used > max) {
      const retryAfterSec = Math.max(1, windowSec - Math.floor((now % (windowSec * 1000)) / 1000));
      return NextResponse.json(
        { error: "You're doing that too fast — please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }
    return null;
  } catch {
    return null; // fail-open
  }
}
