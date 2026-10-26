import { NextRequest, NextResponse, after } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSupabase } from "@/lib/supabase";
import { hashPassword, verifyPassword, safeEqual } from "@/lib/password";
import { createSession, setSessionCookie } from "@/lib/auth";
import { rateLimited } from "@/lib/rate-limit";
import { checkThrottle, registerFailure, clearThrottle, clientIp, reserveAttempt, overLimit, lockIfExceeded } from "@/lib/throttle";
import { logActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

const GENERIC = "Incorrect email or password";

// Verified against when the email has NO account, so unknown-email and
// wrong-password responses both pay one scrypt and take the same time —
// otherwise the latency difference lets an attacker enumerate valid emails.
const DUMMY_HASH = hashPassword("timing-equalizer");

const tooMany = (sec: number) => {
  const mins = Math.ceil(sec / 60);
  return NextResponse.json(
    { error: `Too many attempts. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.` },
    { status: 429, headers: { "Retry-After": String(sec) } }
  );
};

export async function POST(req: NextRequest) {
  const { email, password } = await readJsonObject(req);
  const mail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");
  if (!mail || !pass) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  // Per address: a fixed window that resets by itself, so an office behind one
  // NAT is never locked out by its own successful sign-ins; the escalating lock
  // below is per e-mail only.
  const ipLimited = await rateLimited(`ip:${clientIp(req)}`, "login", 40, 900);
  if (ipLimited) return ipLimited;
  const keys = [`email:${mail}`];

  // Brute-force lockout.
  const throttle = await checkThrottle(keys);
  if (throttle.locked) return tooMany(throttle.retryAfterSec);

  // Reserve this attempt atomically BEFORE verifying anything: a parallel
  // burst can no longer slip past the cap.
  const reserved = await reserveAttempt(keys);
  if (reserved && overLimit(reserved)) return tooMany(Math.max(await lockIfExceeded(reserved), 60));
  const recordFailure = () => (reserved ? lockIfExceeded(reserved) : registerFailure(keys));

  const sb = getSupabase();

  const { data: user, error: lookupErr } = await sb
    .from("users")
    .select("id, email, password_hash, role, token_version, must_change_password, is_active")
    .eq("email", mail)
    .maybeSingle();
  // A failed LOOKUP is not a wrong password: never count it toward lockout.
  if (lookupErr) {
    return NextResponse.json({ error: "Sign-in is temporarily unavailable. Please try again." }, { status: 503 });
  }

  if (user) {
    if (!(await verifyPassword(pass, user.password_hash))) {
      await recordFailure();
      return NextResponse.json({ error: GENERIC }, { status: 401 });
    }
    // Right password, deactivated account: they are entitled to know WHY
    // (it's their own account), and no session is issued.
    if (user.is_active === false) {
      await logActivity({ action: "auth.login_blocked", actor: { id: user.id, email: user.email }, summary: "Sign-in blocked (account deactivated)", ip: clientIp(req) });
      return NextResponse.json({ error: "This account has been deactivated. Ask an admin to re-activate it." }, { status: 403 });
    }
    const token = await createSession({
      uid: user.id,
      role: user.role,
      email: user.email,
      tv: user.token_version ?? 0,
      mc: !!user.must_change_password,
    });
    await setSessionCookie(token);
    // Bookkeeping after the reply: the cookie is already on it.
    const ip = clientIp(req);
    after(async () => {
      await Promise.all([clearThrottle([`email:${mail}`]), sb.from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id)]);
      await logActivity({ action: "auth.login", actor: { id: user.id, email: user.email }, summary: "Signed in", ip });
    });
    return NextResponse.json({ ok: true, mustChangePassword: !!user.must_change_password });
  }

  // First-ever sign-in (no users yet): bootstrap the admin from APP_PASSWORD.
  // The two free, constant-time checks run FIRST and the user COUNT only when
  // they both pass — which is essentially never once the panel is set up.
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const bootstrapAllowed =
    safeEqual(pass, process.env.APP_PASSWORD) &&
    (!adminEmail || adminEmail === mail) &&
    // A failed count is NOT "zero users" — only a definite 0 may bootstrap.
    (await sb.from("users").select("id", { count: "exact", head: true }).then((r) => !r.error && r.count === 0));

  if (bootstrapAllowed) {
    const { data: created, error } = await sb
      .from("users")
      .insert({
        email: mail,
        password_hash: await hashPassword(pass),
        role: "admin",
        department: "management",
        first_name: "Admin",
        last_login_at: new Date().toISOString(),
      })
      .select("id, email, role, token_version")
      .single();
    if (error || !created) {
      return NextResponse.json({ error: "Could not create the admin account" }, { status: 500 });
    }
    console.warn("[auth] Bootstrapped admin account from APP_PASSWORD. Remove APP_PASSWORD from the environment after confirming you can sign in.");
    await clearThrottle(keys);
    const token = await createSession({ uid: created.id, role: created.role, email: created.email, tv: created.token_version ?? 0, mc: false });
    await setSessionCookie(token);
    await logActivity({ action: "auth.bootstrap_admin", actor: { id: created.id, email: created.email }, summary: "Created the first admin account", ip: clientIp(req) });
    return NextResponse.json({ ok: true, bootstrap: true });
  }

  await verifyPassword(pass, await DUMMY_HASH); // equalize timing with the known-email path
  await recordFailure();
  return NextResponse.json({ error: GENERIC }, { status: 401 });
}
