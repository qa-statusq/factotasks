import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { createSession, setSessionCookie, invalidateAuthCache } from "@/lib/auth";
import { fail, ok, serverError, readJsonObject } from "@/lib/api";
import { isUuid } from "@/lib/validate";
import { rateLimited } from "@/lib/rate-limit";
import { logActivity } from "@/lib/activity";
import { SESSION_DAYS, deviceLabel, openSession, revokeSessions } from "@/lib/sessions";

export const dynamic = "force-dynamic";

/** Where the signed-in person is signed in: their own live sign-ins, newest activity first. */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const since = new Date(Date.now() - SESSION_DAYS * 86_400_000).toISOString();
  const { data, error } = await getSupabase()
    .from("user_sessions")
    .select("id, user_agent, ip, created_at, last_seen")
    .eq("user_id", u.uid)
    .eq("token_version", u.tv)
    .is("revoked_at", null)
    .gte("created_at", since)
    .order("last_seen", { ascending: false })
    .limit(50);
  if (error) return serverError(error);
  return NextResponse.json({
    sessions: (data || []).map((r) => ({ id: r.id, device: deviceLabel(r.user_agent as string | null), ip: r.ip, created_at: r.created_at, last_seen: r.last_seen, current: r.id === u.sid })),
    // This browser signed in before sign-ins were recorded: it is not in the list,
    // and "Sign out of all other devices" moves it onto a recorded one.
    untracked: !u.sid,
  });
}

/** End one of your own sign-ins: ?id=<session>. */
export async function DELETE(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const limited = await rateLimited(u.uid, "sessions", 30, 60);
  if (limited) return limited;
  const id = new URL(req.url).searchParams.get("id");
  if (!isUuid(id)) return fail("Session not found", 404);
  let n = 0;
  try {
    n = await revokeSessions(u.uid, { only: id!.toLowerCase() });
  } catch (e) {
    return serverError(e);
  }
  if (!n) return fail("Session not found", 404);
  invalidateAuthCache(u.uid);
  after(() => logActivity({ action: "auth.session_revoke", actor: { id: u.uid, email: u.email }, summary: "Signed out one device" }));
  return ok();
}

/** { others: true, keep_endpoint? } — sign out every other device, including ones from before sign-ins were recorded. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const limited = await rateLimited(u.uid, "sessions", 30, 60);
  if (limited) return limited;
  const b = await readJsonObject(req);
  if (b.others !== true) return fail("Nothing to do");
  const sb = getSupabase();
  // A new token version ends every older token at once (also those that name no session);
  // this browser is re-issued a token on the new version and keeps working.
  const nextVersion = u.tv + 1;
  const { error } = await sb.from("users").update({ token_version: nextVersion }).eq("id", u.uid).eq("token_version", u.tv);
  if (error) return serverError(error);
  invalidateAuthCache(u.uid);
  let sid = u.sid;
  try {
    await revokeSessions(u.uid, { keep: sid });
  } catch (e) {
    return serverError(e);
  }
  if (sid) await sb.from("user_sessions").update({ token_version: nextVersion }).eq("id", sid);
  else sid = await openSession(u.uid, nextVersion, req);
  // Signed-out devices stop getting notifications too; this browser keeps its own.
  {
    let q = sb.from("push_subscriptions").delete().eq("user_id", u.uid);
    if (typeof b.keep_endpoint === "string" && b.keep_endpoint) q = q.neq("endpoint", b.keep_endpoint);
    await q;
  }
  await setSessionCookie(await createSession({ uid: u.uid, role: u.role, email: u.email, tv: nextVersion, mc: u.mc, sid }));
  after(() => logActivity({ action: "auth.session_revoke_others", actor: { id: u.uid, email: u.email }, summary: "Signed out all other devices" }));
  return ok();
}
