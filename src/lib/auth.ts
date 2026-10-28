// Subpath imports (see the note in src/proxy.ts): this module is on the import
// graph of essentially every API route, so pulling the jose barrel dragged JWE,
// JWKS and key-management code into each of their server bundles for nothing.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { getSupabase } from "./supabase";

const COOKIE = "ft_session";

export interface SessionUser {
  uid: string;
  role: string; // "admin" | "member"
  email: string;
  tv: number; // token_version — must match the DB or the session is invalid
  mc: boolean; // must change password before using the app
  /** (032) This sign-in's user_sessions row; absent on tokens issued before it existed. */
  sid?: string;
  /** DB-fresh display name — never stored in the JWT, so a rename takes
   * effect everywhere without re-login. Absent on decode-only sessions. */
  firstName?: string | null;
  lastName?: string | null;
  department?: string;
  title?: string | null;
  color?: string;
  prefs?: Record<string, string | number | boolean>;
}

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("Missing AUTH_SECRET environment variable.");
  // A short secret makes every 7-day session token brute-forceable offline.
  if (s.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return new TextEncoder().encode(s);
}

export async function createSession(user: SessionUser): Promise<string> {
  return new SignJWT({ uid: user.uid, role: user.role, email: user.email, tv: user.tv, mc: user.mc, ...(user.sid ? { sid: user.sid } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

/** Identity attributes of the session cookie. A cookie is overwritten only by
 * a Set-Cookie with the SAME name/path/domain, so the clear below must reuse
 * these verbatim. */
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
} as const;

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(COOKIE, token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 });
}

/**
 * Expire the session cookie ON A GIVEN RESPONSE.
 *
 * Deliberately response-scoped rather than `cookies().delete()`: sign-out's
 * compatibility fallback answers with a 303 redirect built by
 * NextResponse.redirect, and a clear attached directly to that response is
 * guaranteed to ride along with it. This is the single thing that actually
 * ends a session, so it must not depend on request-jar merge semantics.
 */
export function clearSessionCookieOn<T extends NextResponse>(res: T): T {
  // Max-Age AND Expires: every current engine honours Max-Age (and prefers it
  // when both are present), but anything old enough to predate RFC 6265 only
  // understands Expires — and a sign-out that silently fails to expire the
  // cookie is the exact failure this whole path exists to rule out.
  res.cookies.set(COOKIE, "", { ...COOKIE_OPTS, maxAge: 0, expires: new Date(0) });
  return res;
}

/** Decode the session JWT (signature only). Cheap; no DB hit. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const token = (await cookies()).get(COOKIE)?.value;
    if (!token) return null;
    // Algorithm pinned so a future key-type refactor can't introduce alg confusion.
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.uid) return null;
    return {
      uid: String(payload.uid),
      role: String(payload.role || "member"),
      email: String(payload.email || ""),
      tv: Number(payload.tv ?? 0),
      mc: payload.mc === true,
      ...(typeof payload.sid === "string" ? { sid: payload.sid } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Instance-local verification cache. One page navigation fires several API
 * routes in PARALLEL, each re-verifying the SAME session row — 5–10 identical
 * `users` reads per navigation. Caching a POSITIVE verification for a few
 * seconds collapses them to one, cutting the single largest per-request DB
 * cost at scale. Bounded staleness: a role change / forced logout / user
 * deletion takes effect within AUTH_CACHE_MS on other running instances
 * (the mutating instance invalidates itself immediately). Anything that bumps
 * token_version (password change/reset) misses the cache instantly because
 * entries are matched against the token's own `tv`. Misses and failures are
 * never cached.
 */
const AUTH_CACHE_MS = 10_000;
// Hard size cap so a long-lived instance seeing many distinct users can't grow
// this Map without bound (entries are only overwritten/invalidated, never
// swept). Clearing is safe — every entry is a 10s-TTL cache that refetches.
const AUTH_CACHE_MAX = 5_000;
const authCache = new Map<string, { at: number; user: SessionUser }>();
// Single-flight: one page navigation fires several API routes in PARALLEL, and
// they all arrive before the first has populated authCache — so without this
// every route did its OWN `users` verify (4+ identical reads per cold nav, the
// case that matters most under scale-to-zero cold starts). Concurrent verifies
// for the same session now await ONE promise. Keyed by uid+tv so a
// password-change (new tv) never coalesces onto a stale in-flight verify.
const authInflight = new Map<string, Promise<SessionUser | null>>();

/**
 * "We could not verify this session", as distinct from "this session is not
 * valid". A transient DB failure used to be indistinguishable from a deleted
 * user — both surfaced as a 401, and the client treats a 401 as PROOF the
 * session is dead: it clears the cookie and hard-navigates to /login. A blip
 * therefore signed valid users out irreversibly. Callers must map this to a
 * 503, never a 401.
 */
export class AuthUnavailableError extends Error {
  constructor(readonly reason?: unknown) {
    super("Session verification is temporarily unavailable");
    this.name = "AuthUnavailableError";
  }
}

/** Cache key: one entry per sign-in, so ending one session never serves another's verification. */
const cacheKey = (uid: string, sid?: string) => `${uid}:${sid ?? "-"}`;

/** Drop cached verification(s) — call after mutating a user's row or their sessions. */
export function invalidateAuthCache(uid?: string) {
  if (!uid) return authCache.clear();
  for (const k of authCache.keys()) if (k.startsWith(`${uid}:`)) authCache.delete(k);
}

// A session's last_seen is refreshed at most this often (one small write per sign-in).
const SEEN_EVERY_MS = 5 * 60_000;

/**
 * Decode the session AND verify it against the DB: the user must still exist
 * and the token_version must match (so password changes / resets invalidate
 * old sessions). Returns the fresh role/email. One indexed lookup by id,
 * deduped across a navigation's parallel API calls by the cache above.
 */
export async function getAuthenticatedUser(): Promise<SessionUser | null> {
  const decoded = await getSessionUser();
  if (!decoded) return null;
  const hit = authCache.get(cacheKey(decoded.uid, decoded.sid));
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS && hit.user.tv === decoded.tv) return hit.user;

  const key = `${decoded.uid}:${decoded.tv}:${decoded.sid ?? "-"}`;
  const existing = authInflight.get(key);
  if (existing) return existing; // a concurrent verify for this exact session is already running

  const p = (async (): Promise<SessionUser | null> => {
    try {
      const sb = getSupabase();
      // select("*") deliberately: the row is tiny, it stays server-side only
      // (never returned raw), and a column added by a later migration is picked
      // up without touching the one query EVERY authenticated request depends on.
      // The user row and (for tokens that name one) this sign-in's row, in parallel.
      const [{ data, error }, sess] = await Promise.all([
        sb.from("users").select("*").eq("id", decoded.uid).maybeSingle(),
        decoded.sid ? sb.from("user_sessions").select("revoked_at, last_seen").eq("id", decoded.sid).eq("user_id", decoded.uid).maybeSingle() : Promise.resolve(null),
      ]);
      // A failed READ is not a failed AUTH. Returning null here (the old
      // behaviour) made a transient outage look exactly like a deleted user,
      // and the resulting 401 hard-signed-out every tab.
      if (error) throw new AuthUnavailableError(error);
      if (!data) return null;
      if (Number(data.token_version ?? 0) !== decoded.tv) return null;
      // A deactivated account is signed out everywhere within AUTH_CACHE_MS —
      // the row stays (history keeps its names), the session dies.
      if (data.is_active === false) return null;
      // (032) This sign-in was ended from "Signed-in devices", or no longer exists.
      if (sess) {
        if (sess.error) throw new AuthUnavailableError(sess.error);
        if (!sess.data || sess.data.revoked_at) return null;
        if (Date.now() - Date.parse(sess.data.last_seen as string) > SEEN_EVERY_MS) {
          void sb.from("user_sessions").update({ last_seen: new Date().toISOString() }).eq("id", decoded.sid!).then(() => undefined, () => undefined);
        }
      }
      const user: SessionUser = {
        uid: decoded.uid,
        role: data.role,
        email: data.email,
        tv: decoded.tv,
        mc: !!data.must_change_password,
        ...(decoded.sid ? { sid: decoded.sid } : {}),
        firstName: (data.first_name as string | undefined) ?? null,
        lastName: (data.last_name as string | undefined) ?? null,
        department: (data.department as string | undefined) ?? "other",
        title: (data.title as string | undefined) ?? null,
        color: (data.color as string | undefined) ?? "#4f46e5",
        prefs: (data.prefs as Record<string, string | number | boolean> | null | undefined) ?? {},
      };
      if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
      authCache.set(cacheKey(decoded.uid, decoded.sid), { at: Date.now(), user });
      return user;
    } catch (e) {
      // Every throw from here is an infrastructure failure (the decode already
      // succeeded, so the session itself is well-formed) — surface it as
      // "unavailable" so no caller can mistake it for "unauthenticated".
      throw e instanceof AuthUnavailableError ? e : new AuthUnavailableError(e);
    } finally {
      authInflight.delete(key);
    }
  })();
  authInflight.set(key, p);
  return p;
}

