import { getSupabase } from "./supabase";

const MAX_FAILS = 5; // attempts before lockout (per EMAIL)
// Per-IP cap is much higher: a 50-person office shares one NAT address, so a
// handful of typos across the team must not lock everyone out. The IP key
// only catches credential-stuffing from a single source.
const MAX_FAILS_IP = 40;
const BASE_LOCK_MIN = 15; // first lockout duration (minutes), escalates

const capFor = (key: string) => (key.startsWith("ip:") ? MAX_FAILS_IP : MAX_FAILS);

interface ThrottleState {
  locked: boolean;
  retryAfterSec: number;
}

/** Best-effort client IP from proxy headers. The FIRST x-forwarded-for entry
 * is client-supplied and trivially spoofable behind Google's load balancers
 * (Firebase App Hosting appends the REAL client IP at the END of the chain) —
 * an attacker rotating fake first entries could bypass every IP-keyed limit.
 * The LAST entry is written by trusted infrastructure, so key on that. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // XFF_TRUSTED_HOPS = how many trailing entries were added by YOUR proxies
    // (0 = none, so the last entry is the client; 1 = one load balancer appended
    // itself after the client, so the client is second-to-last). Default 0.
    const hops = Math.max(0, Math.min(5, Number(process.env.XFF_TRUSTED_HOPS) || 0));
    const pick = parts[parts.length - 1 - hops] ?? parts[0];
    if (pick) return pick;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/** Returns lockout state for a set of keys (e.g. email + ip). */
export async function checkThrottle(keys: string[]): Promise<ThrottleState> {
  const sb = getSupabase();
  const { data } = await sb.from("auth_throttle").select("key, locked_until").in("key", keys);
  const now = Date.now();
  let maxRetry = 0;
  for (const row of data || []) {
    if (row.locked_until) {
      const until = new Date(row.locked_until).getTime();
      if (until > now) maxRetry = Math.max(maxRetry, Math.ceil((until - now) / 1000));
    }
  }
  return { locked: maxRetry > 0, retryAfterSec: maxRetry };
}

/** Failures older than this are forgiven: without decay, 5 lifetime typos
 * (months apart) would lock a legitimate user harder on every single miss. */
const FAIL_DECAY_MS = 24 * 60 * 60 * 1000;

/** Record a failed attempt and lock the keys once the threshold is exceeded. */
export async function registerFailure(keys: string[]): Promise<void> {
  const sb = getSupabase();
  const { data } = await sb.from("auth_throttle").select("key, fails, updated_at").in("key", keys);
  const now = Date.now();
  const byKey = new Map(
    (data || []).map((r) => [
      r.key,
      // Stale counter (no failures in a day) restarts from zero.
      r.updated_at && now - new Date(r.updated_at).getTime() > FAIL_DECAY_MS ? 0 : (r.fails as number),
    ])
  );
  const nowIso = new Date().toISOString();

  // Keys are distinct (email:/ip: prefixes), so all rows go in ONE batched
  // upsert — one round trip per failed login instead of one per key.
  const rows = keys.map((key) => {
    const fails = (byKey.get(key) ?? 0) + 1;
    let locked_until: string | null = null;
    const cap = capFor(key);
    if (fails >= cap) {
      // Escalate: 15m, 30m, 60m, ... capped at 6h.
      const extra = fails - cap;
      const minutes = Math.min(BASE_LOCK_MIN * Math.pow(2, extra), 360);
      locked_until = new Date(Date.now() + minutes * 60_000).toISOString();
    }
    return { key, fails, locked_until, updated_at: nowIso };
  });
  await sb.from("auth_throttle").upsert(rows, { onConflict: "key" });
}

/**
 * Atomically reserve ONE attempt per key, BEFORE the password is checked.
 *
 * checkThrottle + registerFailure is read-then-write: N parallel guesses all
 * pass the check at fails=0 before any failure lands, so the 5-attempt cap was
 * bypassed by roughly the burst size. Here each key is incremented by the
 * atomic throttle_hit RPC (migration 040, already used by the rl: limiter), so
 * the Nth concurrent attempt sees N and the (MAX_FAILS+1)th is refused before
 * any password is verified. A successful sign-in clears the keys as before.
 *
 * Returns null when the RPC is unavailable (pre-040) — the caller then falls
 * back to the old registerFailure path, so nothing breaks while a migration
 * lags. Counters untouched for FAIL_DECAY_MS are reset first, mirroring the
 * decay registerFailure applied.
 */
export async function reserveAttempt(keys: string[]): Promise<Map<string, number> | null> {
  const sb = getSupabase();
  const stale = new Date(Date.now() - FAIL_DECAY_MS).toISOString();
  const nowIso = new Date().toISOString();
  await Promise.all([
    sb.from("auth_throttle").delete().in("key", keys).lt("updated_at", stale),
    // A lock that has run out is over: the next attempt starts a fresh count.
    // Without this the counter stayed at the cap, so the first try after the
    // wait — even the RIGHT password — re-locked for twice as long.
    sb.from("auth_throttle").delete().in("key", keys).not("locked_until", "is", null).lt("locked_until", nowIso),
  ]);
  const counts = new Map<string, number>();
  for (const key of keys) {
    const { data, error } = await sb.rpc("throttle_hit", { p_key: key });
    if (error || typeof data !== "number") return null;
    counts.set(key, data);
  }
  return counts;
}

/** True once any key's reserved attempt count is past the cap. */
export function overLimit(counts: Map<string, number>): boolean {
  return [...counts].some(([key, n]) => n > capFor(key));
}

/**
 * Lock every key whose reserved count has reached the cap. Same escalation as
 * registerFailure: 15m, 30m, 60m, … capped at 6h.
 */
export async function lockIfExceeded(counts: Map<string, number>): Promise<number> {
  const sb = getSupabase();
  let maxSec = 0;
  for (const [key, n] of counts) {
    const cap = capFor(key);
    if (n < cap) continue;
    const minutes = Math.min(BASE_LOCK_MIN * Math.pow(2, n - cap), 360);
    maxSec = Math.max(maxSec, minutes * 60);
    await sb
      .from("auth_throttle")
      .update({ locked_until: new Date(Date.now() + minutes * 60_000).toISOString() })
      .eq("key", key);
  }
  return maxSec;
}

/** Clear throttle rows after a successful sign-in. */
export async function clearThrottle(keys: string[]): Promise<void> {
  const sb = getSupabase();
  await sb.from("auth_throttle").delete().in("key", keys);
}
