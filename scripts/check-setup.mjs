// Verifies the Supabase project is ready: tables, RPCs and the attachments bucket.
//   npm run check
import { createClient } from "@supabase/supabase-js";

if (!globalThis.WebSocket) {
  const { default: ws } = await import("ws");
  globalThis.WebSocket = ws;
}

const ok = (s) => `  ✓ ${s}`;
const bad = (s) => `  ✗ ${s}`;
let good = true;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run with: node --env-file=.env.local scripts/check-setup.mjs");
  process.exit(1);
}
if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
  console.log(bad("AUTH_SECRET must be at least 32 characters (openssl rand -hex 32)"));
  good = false;
}

console.log("\n— Supabase tables —");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
for (const t of ["users", "apps", "app_members", "releases", "tasks", "task_targets", "task_assignees", "task_status_log", "task_comments", "task_attachments", "meetings", "meeting_series", "meeting_series_members", "meeting_tasks", "meeting_notes", "meeting_recordings", "recording_shares", "notifications", "push_subscriptions", "activity_log", "auth_throttle", "app_settings"]) {
  const { error, count } = await sb.from(t).select("*", { count: "exact", head: true });
  if (error) {
    good = false;
    console.log(bad(`${t}: ${error.message}`));
  } else console.log(ok(`${t} (${count} rows)`));
}

console.log("\n— RPCs —");
for (const [fn, args] of [
  ["dashboard_pack", { p_user: "00000000-0000-0000-0000-000000000000", p_admin: true }],
  ["apps_overview", {}],
  ["team_overview", {}],
  ["work_seconds", { p_from: "2026-10-26T09:00:00+05:30", p_to: "2026-10-26T18:45:00+05:30" }],
  ["meeting_task_ids", { p_meeting: "00000000-0000-0000-0000-000000000000" }],
  ["analytics_pack", { p_from: "2026-01-01", p_to: "2026-01-07", p_user: null }],
  ["meeting_pack", { p_meeting: "00000000-0000-0000-0000-000000000000", p_user: "00000000-0000-0000-0000-000000000000" }],
  ["visible_app_ids", { p_user: "00000000-0000-0000-0000-000000000000" }],
  ["task_visible", { p_task: "00000000-0000-0000-0000-000000000000", p_user: "00000000-0000-0000-0000-000000000000" }],
  ["throttle_hit", { p_key: "rl:check:setup:0" }],
]) {
  const { error } = await sb.rpc(fn, args);
  if (error) {
    good = false;
    console.log(bad(`${fn}(): ${error.message}`));
  } else console.log(ok(`${fn}()`));
}
await sb.from("auth_throttle").delete().eq("key", "rl:check:setup:0");

console.log("\n— Storage —");
const { data: bucket, error: bErr } = await sb.storage.getBucket("attachments");
if (bErr || !bucket) {
  good = false;
  console.log(bad(`bucket "attachments" missing — run supabase/storage.sql`));
} else console.log(ok(`bucket "attachments" (${bucket.public ? "PUBLIC — should be private!" : "private"})`));

console.log("\n— Admin —");
const { count: admins } = await sb.from("users").select("id", { count: "exact", head: true }).eq("role", "admin").eq("is_active", true);
console.log(admins ? ok(`${admins} admin account(s)`) : bad("no admin yet — run `npm run create-admin -- <email> <password>` or sign in once with APP_PASSWORD"));

console.log(good ? "\nSetup looks good." : "\nFix the items marked ✗ (run supabase/schema.sql and supabase/storage.sql in the SQL editor).");
process.exit(good ? 0 : 1);
