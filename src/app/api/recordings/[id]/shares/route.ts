import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, cleanText, isUuid } from "@/lib/validate";
import { rateLimited } from "@/lib/rate-limit";
import { shareFile, unshareFile, DriveError } from "@/lib/google-drive";
import { loadRecording, loadShares, canManage, SHARE_SELECT, shapeShare } from "@/lib/recordings";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Share with e-mail addresses: { emails: string | string[], message? }.
 * Each address gets read access to the Drive file and Google's invitation
 * e-mail (carrying the message). Admins or the recorder.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec) return fail("Recording not found", 404);
  if (!canManage(u, rec)) return fail("Only an admin or the person who recorded can share it", 403);
  if (rec.status !== "ready" || !rec.drive_file_id) return fail("The recording hasn't finished uploading", 409);
  const limited = await rateLimited(u.uid, "share", 60, 3600);
  if (limited) return limited;

  const b = await readJsonObject(req);
  const raw = Array.isArray(b.emails) ? b.emails.map((x) => cleanLine(x, 200)) : cleanLine(b.emails, 2000).split(/[\s,;]+/);
  const emails = [...new Set(raw.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return fail("Enter at least one e-mail address");
  if (emails.length > 10) return fail("Up to 10 addresses at a time");
  const bad = emails.find((e) => !EMAIL_RE.test(e));
  if (bad) return fail(`“${bad}” is not an e-mail address`);
  const message = cleanText(b.message, 1000) || null;

  const existing = await loadShares(id);
  const sb = getSupabase();
  const added: string[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const email of emails) {
    if (existing.some((s) => s.email === email)) continue;
    try {
      const permissionId = await shareFile(rec.drive_file_id, email, message);
      const { error } = await sb.from("recording_shares").insert({ recording_id: id, email, permission_id: permissionId, message, shared_by: u.uid });
      if (error) failed.push({ email, error: error.message });
      else added.push(email);
    } catch (e) {
      failed.push({ email, error: e instanceof DriveError ? e.message : "Couldn't share with this address" });
    }
  }
  if (added.length) after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: rec.meeting_id, summary: `Recording “${rec.name}” shared with ${added.join(", ")}` }));
  const { data } = await sb.from("recording_shares").select(SHARE_SELECT).eq("recording_id", id).order("created_at", { ascending: true });
  return NextResponse.json({ added, failed, shares: ((data ?? []) as unknown as Record<string, unknown>[]).map(shapeShare) });
}

/** Withdraw one address: ?share=<share id>. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  const shareId = new URL(req.url).searchParams.get("share") ?? "";
  if (!isUuid(id) || !isUuid(shareId)) return fail("Share not found", 404);
  const rec = await loadRecording(id);
  if (!rec) return fail("Recording not found", 404);
  if (!canManage(u, rec)) return fail("Only an admin or the person who recorded can change sharing", 403);
  const sb = getSupabase();
  const { data: s } = await sb.from("recording_shares").select("id, email, permission_id").eq("id", shareId).eq("recording_id", id).maybeSingle();
  if (!s) return fail("Share not found", 404);
  if (rec.drive_file_id && s.permission_id) {
    try {
      await unshareFile(rec.drive_file_id, s.permission_id as string);
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't remove the access", 502);
    }
  }
  const { error } = await sb.from("recording_shares").delete().eq("id", shareId);
  if (error) return serverError(error);
  return ok();
}
