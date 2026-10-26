import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { cleanText, isUuid, oneOf } from "@/lib/validate";
import { LIMITS, NOTE_KINDS } from "@/lib/domain";
import { parseLink } from "@/app/api/meetings/[id]/notes/route";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const { data } = await getSupabase().from("meeting_notes").select("id, body, link_url").eq("id", id).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, body: (data.body as string) ?? "", link_url: (data.link_url as string | null) ?? null };
}

/** Edit a minute line (admins; minutes are theirs, open or closed). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Note not found", 404);
  const n = await load(id);
  if (!n) return fail("Note not found", 404);
  const b = await readJsonObject(req);
  const patch: Record<string, unknown> = {};
  if ("body" in b) patch.body = cleanText(b.body, LIMITS.note);
  if ("kind" in b) {
    const kind = oneOf(b.kind, NOTE_KINDS);
    if (!kind) return fail("Invalid kind");
    patch.kind = kind;
  }
  if ("link_url" in b || "link_label" in b) {
    const link = parseLink(b);
    if ("error" in link) return fail(link.error);
    patch.link_url = link.url;
    patch.link_label = link.label;
  }
  // A note is its words or its link — never neither.
  const linkAfter = "link_url" in patch ? (patch.link_url as string | null) : n.link_url;
  const bodyAfter = "body" in patch ? (patch.body as string) : n.body;
  if (!bodyAfter && !linkAfter) return fail("Write the note or add a link");
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
  const { error, data } = await getSupabase().from("meeting_notes").delete().eq("id", id).select("id");
  if (error) return serverError(error);
  if (!data?.length) return fail("Note not found", 404);
  return ok();
}
