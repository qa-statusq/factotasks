import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isUuid } from "@/lib/validate";
import { LIMITS, taskRef } from "@/lib/domain";
import { canSeeTask } from "@/lib/visibility";
import { loadOwnership, involved } from "@/lib/tasks";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { rateLimited } from "@/lib/rate-limit";
import { USER_BRIEF_COLS, embeddedUser } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Just this task's comments, oldest first (the presentation's comment icon) — one round trip. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const [rows, visible] = await Promise.all([
    getSupabase().from("task_comments").select(`id, body, created_at, edited_at, author:users(${USER_BRIEF_COLS})`).eq("task_id", id).order("created_at", { ascending: true }).limit(500),
    canSeeTask(u, id),
  ]);
  if (!visible) return fail("Task not found", 404);
  if (rows.error) return serverError(rows.error);
  return NextResponse.json({
    comments: (rows.data || []).map((r) => ({ id: r.id as string, body: r.body as string, created_at: r.created_at as string, edited_at: (r.edited_at as string | null) ?? null, author: embeddedUser(r.author) })),
  });
}

/** Add a comment (any signed-in user). Everyone involved is notified. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const limited = await rateLimited(u.uid, "comment", 30, 60);
  if (limited) return limited;
  const b = await readJsonObject(req);
  const body = cleanText(b.body, LIMITS.comment);
  if (!body) return fail("Write something first");

  const [own, visible] = await Promise.all([loadOwnership(id), canSeeTask(u, id)]);
  if (!own || !visible) return fail("Task not found", 404);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("task_comments")
    .insert({ task_id: id, user_id: u.uid, body })
    .select(`id, body, created_at, edited_at, author:users(${USER_BRIEF_COLS})`)
    .single();
  if (error) return serverError(error);

  const actor = displayName(u.firstName, u.lastName) || u.email;
  const snippet = body.length > 80 ? `${body.slice(0, 77)}…` : body;
  after(async () => {
    await logActivity({ action: "task.comment", entityType: "task", entityId: id, summary: `Commented on ${taskRef(own.number)}: ${snippet}`, metadata: { number: own.number } });
    await notifyUsers({ userIds: involved(own), kind: "task.comment", taskId: id, actorId: u.uid, message: `${actor} commented on ${taskRef(own.number)}: ${snippet}` });
  });
  return NextResponse.json({
    comment: { id: data.id, body: data.body, created_at: data.created_at, edited_at: data.edited_at ?? null, author: embeddedUser(data.author) },
  });
}
