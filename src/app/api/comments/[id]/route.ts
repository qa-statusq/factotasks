import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isUuid } from "@/lib/validate";
import { LIMITS } from "@/lib/domain";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const { data } = await getSupabase().from("task_comments").select("id, user_id, task_id").eq("id", id).maybeSingle();
  return data;
}

/** Edit your own comment (admins: any). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Comment not found", 404);
  const c = await load(id);
  if (!c) return fail("Comment not found", 404);
  if (c.user_id !== u.uid && u.role !== "admin") return fail("You can only edit your own comments", 403);
  const b = await readJsonObject(req);
  const body = cleanText(b.body, LIMITS.comment);
  if (!body) return fail("A comment can't be empty");
  const { error } = await getSupabase().from("task_comments").update({ body, edited_at: new Date().toISOString() }).eq("id", id);
  if (error) return serverError(error);
  return ok({ body });
}

/** Delete your own comment (admins: any). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Comment not found", 404);
  const c = await load(id);
  if (!c) return fail("Comment not found", 404);
  if (c.user_id !== u.uid && u.role !== "admin") return fail("You can only delete your own comments", 403);
  const { error } = await getSupabase().from("task_comments").delete().eq("id", id);
  if (error) return serverError(error);
  after(() => logActivity({ action: "task.comment_delete", entityType: "task", entityId: c.task_id as string, summary: "Deleted a comment" }));
  return ok();
}
