import { NextResponse } from "next/server";
import { getAuthenticatedUser, AuthUnavailableError, type SessionUser } from "./auth";

/**
 * 503, NOT 401. The client treats a 401 as proof the session is dead and tears
 * the tab down (clears the cookie, hard-navigates to /login); a transient DB
 * fault must never be able to do that. Nothing on the client reacts to a 503,
 * so the stale screens stay painted and the next revalidation recovers.
 */
export const authUnavailable = () =>
  NextResponse.json({ error: "Temporarily unavailable. Please try again." }, { status: 503 });

/** Resolve the session, converting a verification OUTAGE into a 503 response
 * while leaving a genuinely absent/invalid session as `null` (→ 401). */
export async function resolveUser() {
  try {
    return { user: await getAuthenticatedUser(), outage: null as NextResponse | null };
  } catch (e) {
    if (e instanceof AuthUnavailableError) return { user: null, outage: authUnavailable() };
    throw e;
  }
}

/**
 * A must-change-password session may only reach the set-password flow (under
 * /api/auth, which never uses these guards). The Edge proxy (src/proxy.ts) already blocks
 * it everywhere else, but that check reads the JWT claim; this backstop reads the
 * DB-fresh `mc` so enforcement never depends solely on an un-refreshed token.
 */
// A FACTORY, not a shared const: a Response body is a one-shot stream, so a
// single module-level instance returned by two requests on the same warm
// instance would fail on the second serialization.
export const passwordChangeRequired = () =>
  NextResponse.json({ error: "Password change required" }, { status: 403 });

/**
 * Returns a 401 response unless the caller has a valid (DB-verified) session.
 * Any signed-in user (admin OR member) passes — use this only for endpoints that
 * are safe for any authenticated user. For admin-only endpoints use requireAdmin.
 */
export async function requireAuth(): Promise<NextResponse | null> {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.mc) return passwordChangeRequired();
  return null;
}

/** Returns a 401/403 response unless the caller is a signed-in admin. */
export async function requireAdmin(): Promise<NextResponse | null> {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.mc) return passwordChangeRequired();
  if (u.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return null;
}

/**
 * Resolve the caller for routes that need the user object itself (to scope
 * queries by uid/role), or the 401/403/503 response to return instead:
 *   const u = await requireAccessUser();
 *   if (u instanceof NextResponse) return u;
 */
export async function requireAccessUser(): Promise<SessionUser | NextResponse> {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.mc) return passwordChangeRequired();
  return u;
}
