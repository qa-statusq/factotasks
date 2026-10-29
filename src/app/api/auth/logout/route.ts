import { NextRequest, NextResponse, after } from "next/server";
import { clearSessionCookieOn, getSessionUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { revokeSessions } from "@/lib/sessions";

export const dynamic = "force-dynamic";

/**
 * End the session on `res` and hand the audit write to after(). Everything on
 * the response path is local work (read cookie, verify JWT, expire cookie) —
 * NO database round trip, so sign-out can never hang on a cold connection.
 */
async function endSession<T extends NextResponse>(res: T): Promise<T> {
  const u = await getSessionUser();
  clearSessionCookieOn(res);
  // Attachment files are the one thing the browser may keep (privately) while signed in;
  // signing out empties the panel's HTTP cache so nothing stays behind on a shared computer.
  res.headers.set("Clear-Site-Data", '"cache"');
  if (u) {
    after(async () => {
      // This sign-in leaves "Signed-in devices" too.
      if (u.sid) await revokeSessions(u.uid, { only: u.sid }).catch(() => 0);
      await logActivity({ action: "auth.logout", actor: { id: u.uid, email: u.email }, summary: "Signed out" });
    });
  }
  return res;
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  return endSession(NextResponse.json({ ok: true }, { headers: NO_STORE }));
}

/**
 * Escape hatch: sign out via a plain top-level navigation (lib/signout.ts
 * falls back to this whenever the POST can't complete). CSRF is structurally
 * a non-issue — the cookie is SameSite=Strict — so only a PROVEN cross-site
 * initiator is rejected; a missing header is allowed.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Not allowed" }, { status: 403, headers: NO_STORE });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  return endSession(res);
}
