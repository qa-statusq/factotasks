import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isUuid } from "@/lib/validate";
import { LIMITS, PLATFORM_META, taskRef } from "@/lib/domain";
import { RELEASE_SELECT, shapeRelease, applyReleased, AlreadyReleased } from "@/lib/releases";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";

export const dynamic = "force-dynamic";

/**
 * Decide a pending "released" request. Body: { action: "approve" | "reject" | "withdraw", note? }.
 *  approve — admin: the release ships and every linked open task is marked
 *            done, completed at the release time.
 *  reject  — admin: request cleared with the note.
 *  withdraw — the member who asked (or an admin).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Release not found", 404);
  const b = await readJsonObject(req);
  const action = b.action;
  if (action !== "approve" && action !== "reject" && action !== "withdraw") return fail("Invalid action");
  const note = cleanText(b.note, LIMITS.note) || null;

  const sb = getSupabase();
  const { data: cur } = await sb.from("releases").select("id, app_id, platform, version_name, planned_date, released_at, requested_status, requested_by, requested_at, app:apps(name)").eq("id", id).maybeSingle();
  if (!cur) return fail("Release not found", 404);
  if (!cur.requested_status) return fail("There is no pending request on this release");
  const app = (Array.isArray(cur.app) ? cur.app[0] : cur.app) as { name: string } | null;
  const label = `${app?.name ?? "App"} ${PLATFORM_META[cur.platform as "android" | "ios"].label} v${cur.version_name}`;
  const actor = displayName(u.firstName, u.lastName) || u.email;
  const isAdmin = u.role === "admin";

  if (action === "withdraw") {
    if (cur.requested_by !== u.uid && !isAdmin) return fail("Only the requester can withdraw this request", 403);
    const { data: hit, error } = await sb.from("releases").update({ requested_status: null, requested_by: null, requested_at: null, request_note: null }).eq("id", id).not("requested_status", "is", null).select("id");
    if (error) return serverError(error);
    if (!hit?.length) return fail("This request was already decided — refresh to see the release", 409);
    after(() => logActivity({ action: "release.withdraw", entityType: "release", entityId: id, summary: `Withdrew the release request on ${label}` }));
    return respond(u, id, "withdrawn");
  }

  if (!isAdmin) return fail("Admin access required", 403);

  if (action === "approve") {
    const result = await applyReleased(
      { id: cur.id as string, app_id: cur.app_id as string, platform: cur.platform as "android" | "ios", version_name: cur.version_name as string, planned_date: (cur.planned_date as string | null) ?? null, released_at: null, app_name: app?.name ?? "App" },
      u,
      { kind: "approve", note, completedAt: (cur.requested_at as string | null) ?? null }
    ).catch((e) => ({ error: e as unknown }));
    if ("error" in result) return result.error instanceof AlreadyReleased ? fail(result.error.message, 409) : serverError(result.error);
    after(async () => {
      await logActivity({ action: "release.approve", entityType: "release", entityId: id, summary: `Approved ${label} as released — ${result.closed.length} task${result.closed.length === 1 ? "" : "s"} marked done`, metadata: { changes: { status: { from: null, to: "released" } }, closed: result.closed.length } });
      const { data: members } = await sb.from("app_members").select("user_id").eq("app_id", cur.app_id as string);
      await notifyUsers({
        userIds: [cur.requested_by as string, ...(members || []).map((m) => m.user_id as string)],
        kind: "release.released",
        actorId: u.uid,
        message: `${actor} approved ${label} as released${result.closed.length ? ` — ${result.closed.map((t) => taskRef(t.number)).join(", ")} marked done` : ""}`,
      });
    });
    return respond(u, id, "approved", result.closed.length);
  }

  // reject — only while the request is still pending (an approve a moment earlier wins)
  const { data: hit, error } = await sb.from("releases").update({ requested_status: null, requested_by: null, requested_at: null, request_note: null }).eq("id", id).not("requested_status", "is", null).select("id");
  if (error) return serverError(error);
  if (!hit?.length) return fail("This request was already decided — refresh to see the release", 409);
  after(async () => {
    await logActivity({ action: "release.reject", entityType: "release", entityId: id, summary: `Sent back the release request on ${label}${note ? ` — ${note}` : ""}` });
    await notifyUsers({ userIds: [cur.requested_by as string], kind: "release.rejected", actorId: u.uid, message: `${actor} sent back your release request for ${label}${note ? ` — ${note}` : ""}` });
  });
  return respond(u, id, "rejected");
}

async function respond(u: { role: string }, id: string, mode: string, closed = 0) {
  const { data } = await getSupabase().from("releases").select(RELEASE_SELECT).eq("id", id).maybeSingle();
  return memberJson(u, { release: data ? shapeRelease(data as unknown as Record<string, unknown>) : null, mode, closed });
}
