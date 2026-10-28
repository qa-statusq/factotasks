import { NextRequest, after } from "next/server";
import { createSession, setSessionCookie, invalidateAuthCache } from "@/lib/auth";
import { revokeSessions } from "@/lib/sessions";
import { resolveUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { hashPassword, verifyPassword } from "@/lib/password";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Change the signed-in user's own password. Invalidates every OTHER session. */
export async function POST(req: NextRequest) {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return fail("Unauthorized", 401);

  // The current-password check is the last barrier for a stolen session —
  // throttle it so it can't be brute-forced.
  const limited = await rateLimited(u.uid, "pwchange", 5, 60);
  if (limited) return limited;

  const { current, next, keep_endpoint } = await readJsonObject(req);
  if (!current || !next) return fail("Current and new password are required");
  if (String(next).length < 8) return fail("New password must be at least 8 characters");
  if (String(next).length > 200) return fail("Password is too long");

  const sb = getSupabase();
  const { data: user } = await sb.from("users").select("password_hash, token_version").eq("id", u.uid).maybeSingle();
  if (!user || !(await verifyPassword(String(current), user.password_hash))) {
    return fail("Current password is incorrect");
  }

  const nextVersion = Math.max(Number(user.token_version ?? 0), u.tv) + 1;
  const { error } = await sb
    .from("users")
    .update({ password_hash: await hashPassword(String(next)), token_version: nextVersion, must_change_password: false })
    .eq("id", u.uid);
  if (error) return serverError(error);
  // The revoked token shares the OLD tv the cache holds — drop it now.
  invalidateAuthCache(u.uid);
  // Signed-out devices stop getting push too; this browser keeps its own.
  {
    let q = sb.from("push_subscriptions").delete().eq("user_id", u.uid);
    if (typeof keep_endpoint === "string" && keep_endpoint) q = q.neq("endpoint", keep_endpoint);
    await q;
  }

  // Re-issue THIS session so the user stays signed in; all others are invalidated.
  // Every other sign-in ends (token_version moved on); this one stays, under its own session row.
  await revokeSessions(u.uid, { keep: u.sid }).catch(() => 0);
  if (u.sid) await getSupabase().from("user_sessions").update({ token_version: nextVersion }).eq("id", u.sid);
  const token = await createSession({ uid: u.uid, role: u.role, email: u.email, tv: nextVersion, mc: false, sid: u.sid });
  await setSessionCookie(token);
  after(() => logActivity({ action: "auth.password_change", actor: { id: u.uid, email: u.email }, summary: "Changed their password" }));
  return ok();
}
