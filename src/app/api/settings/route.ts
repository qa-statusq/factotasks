import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin, requireAuth } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { cleanLine } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Workspace settings. Readable by everyone (the UI explains the approval
 * policy to members); writable by admins only. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  return NextResponse.json({ settings: await getSettings() });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const b = await readJsonObject(req);
  const rows: { key: string; value: unknown }[] = [];
  const changes: string[] = [];

  if (b.approval_policy && typeof b.approval_policy === "object") {
    const mode = (b.approval_policy as { mode?: unknown }).mode;
    if (mode !== "done_only" && mode !== "all" && mode !== "none") return fail("Invalid approval policy");
    rows.push({ key: "approval_policy", value: { mode } });
    changes.push(`approval policy → ${mode}`);
  }
  if (b.meeting && typeof b.meeting === "object") {
    const m = b.meeting as { weekday?: unknown; hour?: unknown };
    const weekday = Number(m.weekday);
    const hour = Number(m.hour);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return fail("Meeting weekday must be 0 (Sun) – 6 (Sat)");
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fail("Meeting hour must be 0–23");
    rows.push({ key: "meeting", value: { weekday, hour } });
    changes.push(`meeting → day ${weekday} ${hour}:00`);
  }
  if ("workspace_name" in b) {
    const name = cleanLine(b.workspace_name, 60);
    if (!name) return fail("Workspace name can't be empty");
    rows.push({ key: "workspace_name", value: name });
    changes.push(`workspace name → ${name}`);
  }
  if (!rows.length) return fail("Nothing to update");

  const { error } = await getSupabase().from("app_settings").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "key" });
  if (error) return serverError(error);
  invalidateSettingsCache();
  after(() => logActivity({ action: "settings.update", entityType: "settings", summary: `Updated settings (${changes.join(", ")})` }));
  return ok({ settings: await getSettings() });
}
