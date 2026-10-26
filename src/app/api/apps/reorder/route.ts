import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { parseUuidList } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Save the hand-arranged order of apps (admin only): body { ids: [...] } in
 * the order shown. Every list that names apps — Apps, task targets, People,
 * meeting agendas and decks, analytics — follows it.
 */
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const b = await readJsonObject(req);
  const ids = parseUuidList(b.ids, 200);
  if (!ids || !ids.length) return fail("Send the app ids in order");
  const { error } = await getSupabase().rpc("apps_reorder", { p_ids: ids });
  if (error) return serverError(error);
  await logActivity({ action: "app.reorder", entityType: "app", summary: `Arranged the apps (${ids.length})`, metadata: { count: ids.length } });
  return NextResponse.json({ ok: true });
}
