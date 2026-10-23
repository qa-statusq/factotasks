import { NextRequest, NextResponse, after } from "next/server";
import { invalidateAuthCache, type SessionUser } from "@/lib/auth";
import { passwordChangeRequired, resolveUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { logActivity } from "@/lib/activity";
import { rateLimited } from "@/lib/rate-limit";
import { serverError, readJsonObject, EXPECTED_EMBED_MISS } from "@/lib/api";
import { cleanName, displayName } from "@/lib/name";
import { cleanLine, isHexColor } from "@/lib/validate";
import { LIMITS, USER_COLORS } from "@/lib/domain";

export const dynamic = "force-dynamic";

// If a valid session has been idle at least this long, the next visit counts
// as a fresh "return" — recorded in Activity + last sign-in.
const RETURN_AFTER_MS = 30 * 60 * 1000;

const publicMe = (u: SessionUser) => ({
  id: u.uid,
  email: u.email,
  role: u.role,
  first_name: u.firstName ?? null,
  last_name: u.lastName ?? null,
  department: u.department ?? "other",
  title: u.title ?? null,
  color: u.color ?? USER_COLORS[0],
  prefs: u.prefs ?? {},
});

export async function GET() {
  // A verification OUTAGE is a 503, never a 401: /me runs on every page load,
  // and the client treats a 401 as proof the session is dead.
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Record a return visit AFTER the response is sent — never on the latency
  // path of every page load. The conditional update is race-safe.
  const user = { uid: u.uid, email: u.email };
  after(async () => {
    try {
      const sb = getSupabase();
      const cutoff = new Date(Date.now() - RETURN_AFTER_MS).toISOString();
      const { data: bumped } = await sb
        .from("users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", user.uid)
        .lt("last_login_at", cutoff)
        .select("id");
      if (bumped && bumped.length) {
        await logActivity({
          action: "auth.login",
          actor: { id: user.uid, email: user.email },
          summary: "Returned to the panel (existing session)",
          metadata: { kind: "session_resume" },
        });
      }
    } catch {
      /* best-effort */
    }
  });

  return NextResponse.json({ user: publicMe(u) });
}

/**
 * Self-service profile update: name, designation and avatar colour. The target
 * row is ALWAYS the verified session's own uid; the update object is a fixed
 * allowlist (role/email/department/password are unreachable here).
 */
export async function PATCH(req: NextRequest) {
  const { user: u, outage } = await resolveUser();
  if (outage) return outage;
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.mc) return passwordChangeRequired();

  const limited = await rateLimited(u.uid, "profile", 10, 60);
  if (limited) return limited;

  const b = await readJsonObject(req);
  const update: Record<string, unknown> = {};
  if ("first_name" in b || "last_name" in b) {
    const first = cleanName(b.first_name);
    const last = cleanName(b.last_name);
    if (!first) return NextResponse.json({ error: "Enter your first name" }, { status: 400 });
    update.first_name = first;
    update.last_name = last || null;
  }
  if ("title" in b) update.title = cleanLine(b.title, LIMITS.userTitle) || null;
  if ("color" in b) {
    if (!isHexColor(b.color)) return NextResponse.json({ error: "Pick a valid colour" }, { status: 400 });
    update.color = String(b.color).toLowerCase();
  }
  // UI preferences: merged into the person's own prefs. Scalars only, bounded.
  let prefs: Record<string, string | number | boolean> | null = null;
  if (b.prefs && typeof b.prefs === "object" && !Array.isArray(b.prefs)) {
    prefs = { ...(u.prefs ?? {}) };
    for (const [k, v] of Object.entries(b.prefs as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_.-]{0,39}$/i.test(k)) return NextResponse.json({ error: "Invalid preference" }, { status: 400 });
      if (v === null || v === undefined) delete prefs[k];
      else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 80)) prefs[k] = v;
      else return NextResponse.json({ error: "Invalid preference value" }, { status: 400 });
    }
    if (Object.keys(prefs).length > 60) return NextResponse.json({ error: "Too many preferences" }, { status: 400 });
    update.prefs = prefs;
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const { error } = await getSupabase().from("users").update(update).eq("id", u.uid);
  if (error) {
    // A database without 012 has no prefs column: keep the session's copy
    // for this request and say nothing — everything else still saves.
    if (!(prefs && EXPECTED_EMBED_MISS.has((error as { code?: string }).code ?? "") && Object.keys(update).length === 1)) return serverError(error);
  }
  // The next /me (and every guard) must see the change immediately.
  invalidateAuthCache(u.uid);
  const merged: SessionUser = {
    ...u,
    firstName: (update.first_name as string | undefined) ?? u.firstName,
    lastName: "last_name" in update ? (update.last_name as string | null) : u.lastName,
    title: "title" in update ? (update.title as string | null) : u.title,
    color: (update.color as string | undefined) ?? u.color,
    prefs: prefs ?? u.prefs,
  };
  const onlyPrefs = prefs && Object.keys(update).length === 1;
  if (!onlyPrefs) await logActivity({
    action: "user.profile",
    entityType: "user",
    entityId: u.uid,
    summary: `Updated their profile${update.first_name ? ` (${displayName(merged.firstName, merged.lastName)})` : ""}`,
  });
  return NextResponse.json({ user: publicMe(merged) });
}
