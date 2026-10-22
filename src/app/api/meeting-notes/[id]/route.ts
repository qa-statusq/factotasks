import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { cleanText, isUuid, oneOf } from "@/lib/validate";
import { LIMITS, NOTE_KINDS } from "@/lib/domain";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const { data } = await getSupabase().from("meeting_notes").select("id, created_by, meeting:meetings(status)").eq("id", id).maybeSingle();
  if (!data) return null;
  const m = (Array.isArray(data.meeting) ? data.meeting[0] : data.meeting) as { status: string } | null;
  return { id: data.id as string, created_by: data.created_by as string | null, finalized: m?.status === "finalized" };
}

/** Edit your own note (admins: any; closed meetings: admins only). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Note not found", 404);
  const n = await load(id);
  if (!n) return fail("Note not found", 404);
  const admin = u.role === "admin";
  if (n.created_by !== u.uid && !admin) return fail("You can only edit your own notes", 403);
  if (n.finalized && !admin) return fail("This meeting is closed", 403);
  const b = await readJsonObject(req);
  const patch: Record<string, unknown> = {};
  if ("body" in b) {
    const body = cleanText(b.body, LIMITS.note);
    if (!body) return fail("A note can't be empty");
    patch.body = body;
  }
  if ("kind" in b) {
    const kind = oneOf(b.kind, NOTE_KINDS);
    if (!kind) return fail("Invalid kind");
    patch.kind = kind;
  }
  if (!Object.keys(patch).length) return fail("Nothing to update");
  const { error } = await getSupabase().from("meeting_notes").update(patch).eq("id", id);
  if (error) return serverError(error);
  return ok();
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Note not found", 404);
  const n = await load(id);
  if (!n) return fail("Note not found", 404);
  const admin = u.role === "admin";
  if (n.created_by !== u.uid && !admin) return fail("You can only delete your own notes", 403);
  if (n.finalized && !admin) return fail("This meeting is closed", 403);
  const { error } = await getSupabase().from("meeting_notes").delete().eq("id", id);
  if (error) return serverError(error);
  return ok();
}
