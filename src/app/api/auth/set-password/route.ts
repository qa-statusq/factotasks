import { NextRequest, after } from "next/server";
import { createSession, setSessionCookie, invalidateAuthCache } from "@/lib/auth";
import { resolveUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { hashPassword } from "@/lib/password";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Set a new password WITHOUT the current one — only for the mandatory
 * first-login / post-reset flow (the session, issued against the temporary
 * password, is the proof of identity). A normal change goes via /password.
 */
export async function POST(req: NextRequest) {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return fail("Unauthorized", 401);

  const limited = await rateLimited(u.uid, "pwchange", 5, 60);
  if (limited) return limited;

  if (!u.mc) return fail("Use the change-password form (current password required).", 403);

  const { password } = await readJsonObject(req);
  if (!password || String(password).length < 8) return fail("New password must be at least 8 characters");
  if (String(password).length > 200) return fail("Password is too long");

  const sb = getSupabase();
  // The read MUST be inspected: a failed read used to yield nextVersion = 1 —
  // a DOWNGRADE that re-validated previously revoked tokens.
  const { data: cur, error: readErr } = await sb.from("users").select("token_version").eq("id", u.uid).maybeSingle();
  if (readErr || !cur) return serverError(readErr ?? new Error("user row unavailable"));
  const nextVersion = Math.max(Number(cur.token_version ?? 0), u.tv) + 1;

  const { error } = await sb
    .from("users")
    .update({ password_hash: await hashPassword(String(password)), must_change_password: false, token_version: nextVersion })
    .eq("id", u.uid);
  if (error) return serverError(error);
  invalidateAuthCache(u.uid);

  const token = await createSession({ uid: u.uid, role: u.role, email: u.email, tv: nextVersion, mc: false });
  await setSessionCookie(token);
  after(() => logActivity({ action: "auth.password_set", actor: { id: u.uid, email: u.email }, summary: "Set a new password (first login)" }));
  return ok();
}
