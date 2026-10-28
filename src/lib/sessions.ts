import { getSupabase } from "./supabase";
import { clientIp } from "./throttle";

/** How long a sign-in lasts (the session token's own life). */
export const SESSION_DAYS = 7;

/**
 * Record a new sign-in and return its id (carried in the session token). A
 * failure here never blocks signing in: the token then simply names no session
 * (like tokens issued before 032), and "Sign out of all other devices" still
 * ends it through token_version.
 */
export async function openSession(uid: string, tokenVersion: number, req: Request): Promise<string | undefined> {
  const { data, error } = await getSupabase()
    .from("user_sessions")
    .insert({ user_id: uid, token_version: tokenVersion, user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null, ip: clientIp(req).slice(0, 64) || null })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[sessions] could not record the sign-in:", error);
    return undefined;
  }
  return data.id as string;
}

/** End sign-ins of `uid`: one (`only`), or every one except `keep`. */
export async function revokeSessions(uid: string, opts: { only?: string; keep?: string }): Promise<number> {
  let q = getSupabase().from("user_sessions").update({ revoked_at: new Date().toISOString() }).eq("user_id", uid).is("revoked_at", null);
  if (opts.only) q = q.eq("id", opts.only);
  if (opts.keep) q = q.neq("id", opts.keep);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/** "Chrome on Windows", "Safari on iPhone" — a readable name for a sign-in's browser. */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua || "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "Mac" : /CrOS/.test(s) ? "Chromebook" : /Linux/.test(s) ? "Linux" : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown browser";
}
