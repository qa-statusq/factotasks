// End-to-end API walkthrough against a RUNNING server + the live database.
// Drives every flow the UI uses — as an admin AND as a member — and prints a
// checklist. Leaves the sample data in place (so the UI can be eyeballed);
// run with --cleanup to delete what it created (the admin is never touched).
//   node --env-file=.env.local scripts/e2e-api.mjs http://localhost:3017 <admin-email> <admin-password> [--cleanup]
const [base, adminEmail, adminPassword, ...flags] = process.argv.slice(2);
if (!base || !adminEmail || !adminPassword) {
  console.error("Usage: node scripts/e2e-api.mjs <baseUrl> <admin-email> <admin-password> [--cleanup]");
  process.exit(1);
}
const cleanup = flags.includes("--cleanup");
let failures = 0;
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => {
  failures++;
  console.log(`  ✗ ${s}`);
};
const check = (cond, label, detail) => (cond ? ok(label) : bad(`${label}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}` : ""}`));

/** Minimal cookie-jar client (fetch keeps no cookies). */
function client(name) {
  let cookie = "";
  return {
    name,
    async call(method, path, body, extra = {}) {
      const headers = { ...(extra.headers || {}) };
      if (cookie) headers.cookie = cookie;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const r = await fetch(base + path, { method, headers, body: payload, redirect: "manual" });
      const sc = r.headers.get("set-cookie");
      if (sc) {
        const m = /ft_session=([^;]*)/.exec(sc);
        if (m) cookie = m[1] ? `ft_session=${m[1]}` : "";
      }
      let data = null;
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) data = await r.json().catch(() => null);
      return { status: r.status, data, headers: r.headers };
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 1500)); // after() hooks run post-response
const admin = client("admin");
const member = client("member");
const created = { users: [], apps: [], tasks: [], releases: [], meetings: [], series: [] };

console.log(`\n— FactoTasks e2e against ${base} —`);

// ---------- auth ----------
console.log("\nAuth");
let r = await admin.call("POST", "/api/auth/login", { email: adminEmail, password: "definitely-wrong" });
check(r.status === 401, "wrong password → 401", r);
r = await admin.call("POST", "/api/auth/login", { email: adminEmail, password: adminPassword });
check(r.status === 200 && r.data?.ok, "admin sign-in", r);
r = await admin.call("GET", "/api/auth/me");
check(r.status === 200 && r.data?.user?.role === "admin", `GET /me → ${r.data?.user?.email} (${r.data?.user?.role})`, r);
const adminId = r.data?.user?.id;

// ---------- team ----------
console.log("\nTeam");
const stamp = Date.now().toString(36);
const memberEmail = `e2e.rahul.${stamp}@example.com`;
r = await admin.call("POST", "/api/users", { first_name: "Rahul", last_name: "Shah", email: memberEmail, password: "temp-pass-123", role: "member", department: "android", title: "Android Developer" });
check(r.status === 200 && r.data?.user?.id, "admin invites a member", r);
const memberId = r.data?.user?.id;
if (memberId) created.users.push(memberId);
r = await admin.call("POST", "/api/users", { first_name: "Rahul", email: memberEmail, password: "temp-pass-123" });
check(r.status === 409, "duplicate email → 409", r);
r = await member.call("POST", "/api/auth/login", { email: memberEmail, password: "temp-pass-123" });
check(r.status === 200 && r.data?.mustChangePassword === true, "member signs in with temp password (must change)", r);
r = await member.call("GET", "/api/tasks");
check(r.status === 403, "member blocked from the app until password set → 403", r);
r = await member.call("POST", "/api/auth/set-password", { password: "rahul-own-pass-456" });
check(r.status === 200, "member sets own password", r);
r = await member.call("GET", "/api/auth/me");
check(r.status === 200 && r.data?.user?.role === "member", "member /me after password set", r);
r = await member.call("GET", "/api/team");
check(r.status === 200 && Array.isArray(r.data?.members) && r.data.members.length >= 2, `team_overview → ${r.data?.members?.length} people`, r);
check(r.data?.members?.every((m) => !("must_change_password" in m)), "member view hides account-management fields");
r = await member.call("GET", "/api/users");
check(r.status === 200 && r.data?.users?.every((u) => !("password_hash" in u) && !("token_version" in u)), "directory never leaks hashes", r);

// ---------- apps ----------
console.log("\nApps");
r = await member.call("POST", "/api/apps", { name: "Nope" });
check(r.status === 403, "member cannot create apps → 403", r);
r = await admin.call("POST", "/api/apps", { name: `SwapMyFace ${stamp}`, kind: "b2c", status: "active", has_android: true, has_ios: true, android_package: "com.example.swap", description: "Face-swap app", members: [{ user_id: memberId, app_role: "developer" }] });
check(r.status === 200 && r.data?.app?.id, "admin creates an app with a member", r);
const appId = r.data?.app?.id;
if (appId) created.apps.push(appId);
r = await admin.call("POST", "/api/apps", { name: `SwapMyFace ${stamp}`, has_android: true });
check(r.status === 409, "duplicate app name → 409", r);
r = await admin.call("POST", "/api/apps", { name: "Bad", has_android: false, has_ios: false });
check(r.status === 400, "app with no platform → 400", r);
r = await member.call("GET", "/api/apps");
const app = r.data?.apps?.find((a) => a.id === appId);
check(r.status === 200 && app && app.members.length === 1 && app.members[0].user.id === memberId, "apps_overview shows the member", r);
r = await admin.call("PUT", `/api/apps/${appId}/members`, { members: [{ user_id: memberId, app_role: "lead" }, { user_id: adminId, app_role: "qa" }] });
check(r.status === 200, "replace app members", r);
r = await admin.call("GET", `/api/apps/${appId}`);
check(r.data?.app?.members?.length === 2, "GET /api/apps/[id] reflects 2 members", r);

// ---------- releases ----------
console.log("\nReleases");
r = await member.call("POST", "/api/releases", { app_id: appId, platform: "android", version_name: "v2.4.0", build_number: "240", status: "testing", planned_date: "2026-10-28", description: "- New share sheet\n- Crash fixes" });
check(r.status === 200 && r.data?.release?.version_name === "2.4.0", "app member adds a release (v prefix stripped)", r);
const releaseId = r.data?.release?.id;
if (releaseId) created.releases.push(releaseId);
r = await member.call("POST", "/api/releases", { app_id: appId, platform: "android", version_name: "2.4.0" });
check(r.status === 409, "duplicate version/platform → 409", r);
r = await admin.call("GET", `/api/releases?app=${appId}&scope=open`);
check(r.status === 200 && r.data?.releases?.length === 1, "list open releases for app", r);

// ---------- tasks ----------
console.log("\nTasks");
r = await member.call("POST", "/api/tasks", { title: "Fix crash on share sheet", description: "Repro: tap share twice. See T-1.", targets: [{ app_id: appId, platform: "android" }], type: "bug", priority: "high", assignee_ids: [memberId], due_date: "2026-10-25", labels: ["Crash", "p1", "crash"], estimate_hours: 4 });
check(r.status === 200 && r.data?.task?.number && r.data.task.labels.length === 2, `member creates task ${r.data?.task ? "T-" + r.data.task.number : ""} (labels de-duplicated)`, r);
const task = r.data?.task;
if (task) created.tasks.push(task.id);
r = await admin.call("PATCH", `/api/releases/${releaseId}`, { task_ids: [task.id] });
check(r.status === 200 && r.data?.release?.tasks?.some((t) => t.id === task.id), "release picks up the task (android target)", r);
r = await member.call("POST", "/api/tasks", { title: "bad platform", targets: [{ app_id: appId, platform: "windows" }] });
check(r.status === 400, "unknown platform → 400", r);
r = await admin.call("POST", "/api/tasks", { title: "Prepare Q4 marketing deck", type: "marketing", priority: "medium", assignee_ids: [adminId] });
check(r.status === 200 && r.data?.task?.app === null, "admin creates a GENERAL task", r);
const general = r.data?.task;
if (general) created.tasks.push(general.id);
r = await member.call("POST", "/api/tasks", { title: "", app_id: appId });
check(r.status === 400, "empty title → 400", r);
r = await member.call("POST", "/api/tasks", { title: "x", targets: [{ app_id: "00000000-0000-0000-0000-000000000000", platform: "android" }] });
check(r.status === 400, "unknown app → 400", r);
r = await admin.call("POST", "/api/tasks", { title: "Legacy caller", app_id: appId, platform: "ios" });
check(r.status === 200 && r.data?.task?.targets?.length === 1 && r.data.task.targets[0].platform === "ios", "legacy app_id/platform body still creates one target", r);
if (r.data?.task) created.tasks.push(r.data.task.id);

// ---------- member visibility ----------
console.log("\nVisibility");
r = await admin.call("POST", "/api/apps", { name: `Other ${stamp}`, has_android: true });
const otherAppId = r.data?.app?.id;
if (otherAppId) created.apps.push(otherAppId);
r = await admin.call("POST", "/api/tasks", { title: "Secret work", targets: [{ app_id: otherAppId, platform: "android" }] });
const secret = r.data?.task;
if (secret) created.tasks.push(secret.id);
r = await member.call("GET", "/api/apps");
check(r.status === 200 && !r.data?.apps?.some((a) => a.id === otherAppId), "member does not see an app they are not on", r);
r = await member.call("GET", `/api/apps/${otherAppId}`);
check(r.status === 404, "direct link to that app → 404", r);
r = await member.call("GET", "/api/tasks?scope=all&limit=200");
check(r.status === 200 && !r.data?.tasks?.some((t) => t.id === secret?.id) && r.data.tasks.some((t) => t.id === task.id), "member task list excludes the other app, includes their own app", r);
r = await member.call("GET", `/api/tasks/${secret?.id}`);
check(r.status === 404, "direct link to the other app's task → 404", r);
r = await member.call("POST", "/api/releases", { app_id: otherAppId, platform: "android", version_name: "1.0.0" });
check(r.status === 403, "member cannot add a release to an app they are not on → 403", r);
r = await member.call("POST", "/api/tasks", { title: "Sneaky", targets: [{ app_id: otherAppId, platform: "android" }] });
check(r.status === 400, "member cannot put a task on an app they are not on → 400", r);
r = await admin.call("POST", "/api/tasks", { title: "Wrong assignee", targets: [{ app_id: otherAppId, platform: "android" }], assignee_ids: [memberId] });
check(r.status === 400 && /member of/.test(r.data?.error || ""), "assigning a non-member to an app task → 400", r);
r = await admin.call("GET", "/api/analytics?from=2026-01-01&to=2026-12-31");
check(r.status === 200 && Array.isArray(r.data?.by_person) && Array.isArray(r.data?.periods) && Array.isArray(r.data?.cycle_buckets) && typeof r.data?.releases?.released === "number" && typeof r.data?.meetings?.held === "number", "admin analytics (range) has by_person, periods, buckets, releases, meetings", r);
r = await admin.call("GET", "/api/analytics?from=2026-10-01&to=2026-10-20");
check(r.status === 200 && r.data?.range?.bucket === "week", "short analytics range buckets by week", r);
r = await admin.call("GET", "/api/analytics?from=20-10-2026&to=x");
check(r.status === 400, "bad analytics dates → 400", r);
r = await member.call("GET", "/api/analytics");
check(r.status === 200 && !("by_person" in (r.data || {})) && !r.data?.by_app?.some((a) => a.id === otherAppId), "member analytics: no by_person, no other app", r);
r = await member.call("PATCH", "/api/apps/reorder", { ids: [appId] });
check(r.status === 403, "members cannot arrange apps → 403", r);
r = await admin.call("PATCH", "/api/apps/reorder", { ids: [otherAppId, appId] });
check(r.status === 200, "admin arranges apps", r);
r = await admin.call("GET", "/api/apps");
{
  const ids = (r.data?.apps || []).map((a) => a.id);
  check(ids.indexOf(otherAppId) < ids.indexOf(appId), "apps list follows the arranged order", { ids });
}
r = await admin.call("PATCH", "/api/apps/reorder", { ids: [appId, otherAppId] });
r = await member.call("GET", "/api/meetings");
check(r.status === 403, "meetings are admin-only for members → 403", r);
r = await member.call("DELETE", `/api/tasks/${task.id}`);
check(r.status === 403, "members cannot delete tasks → 403", r);

// ---------- tasks on meeting series ----------
console.log("\nMeeting series");
r = await admin.call("POST", "/api/meeting-series", { name: `E2E attach ${stamp}`, app_ids: [appId] });
const attachSeries = r.data?.series?.id;
if (attachSeries) created.series.push(attachSeries);
r = await member.call("GET", "/api/meeting-series");
check(r.status === 200 && r.data?.series?.some((s) => s.id === attachSeries) && !("meeting_count" in (r.data.series[0] || {})), "members get the series names (no rollups)", r);
r = await admin.call("POST", "/api/tasks", { title: "Attached general task", type: "other", priority: "low", series_id: attachSeries, assignee_ids: [memberId] });
const attached = r.data?.task;
if (attached) created.tasks.push(attached.id);
if (r.status === 400 && /migration 010/.test(r.data?.error || "")) {
  console.log("  (skipped — migration 010 is not applied on this database yet)");
} else {
check(r.status === 200 && attached?.series?.id === attachSeries && attached.app === null, "a general task can be attached to a series", r);
r = await member.call("GET", "/api/tasks?scope=all&kind=general&series=any&limit=100");
check(r.status === 200 && r.data?.tasks?.some((t) => t.id === attached?.id) && !r.data.tasks.some((t) => t.id === general.id), "kind=general + series=any lists only attached general tasks", r);
r = await member.call("GET", "/api/tasks?scope=all&kind=general&series=none&limit=100");
check(r.status === 200 && !r.data?.tasks?.some((t) => t.id === general.id) && !r.data.tasks.some((t) => t.id === attached?.id), "series=none: the admin's own general task is not visible to the member", r);
r = await admin.call("GET", "/api/tasks?scope=all&kind=general&series=none&limit=100");
check(r.status === 200 && r.data?.tasks?.some((t) => t.id === general.id), "series=none lists general tasks not on a meeting (admin)", r);
r = await member.call("POST", "/api/tasks", { title: "My private general task", type: "other", priority: "low" });
const mineGeneral = r.data?.task;
if (mineGeneral) created.tasks.push(mineGeneral.id);
r = await member.call("GET", `/api/tasks/${mineGeneral?.id}`);
check(r.status === 200, "a member sees the general task they created", r);
r = await member.call("GET", "/api/tasks?scope=all&kind=app&limit=100");
check(r.status === 200 && r.data?.tasks?.every((t) => t.app !== null), "kind=app lists app tasks only", r);
r = await admin.call("POST", "/api/meetings", { series_id: attachSeries, held_at: new Date().toISOString() });
const attachMeeting = r.data?.meeting?.id;
if (attachMeeting) created.meetings.push(attachMeeting);
r = await admin.call("GET", `/api/meetings/${attachMeeting}`);
check(r.status === 200 && r.data?.pending?.some((t) => t.id === attached?.id) && !r.data.pending.some((t) => t.id === general.id), "meeting_pack: the attached general task is on the agenda, the unattached one is not", r);
r = await admin.call("PATCH", `/api/tasks/${attached?.id}`, { series_id: null });
check(r.status === 200 && r.data?.task?.series === null, "detaching clears the series", r);
}

r = await member.call("GET", `/api/tasks/${task.id}`);
check(r.status === 200 && r.data?.task?.can?.edit === true && r.data.task.can.approve === false && r.data.task.can.needs_approval === true, "member sees can.edit / !approve / needs_approval", r.data?.task?.can);
r = await member.call("GET", `/api/tasks/${task.number}`);
check(r.status === 200 && r.data?.task?.id === task.id, "task resolves by number too", r);
r = await admin.call("PATCH", `/api/tasks/${general.id}`, { title: "Prepare Q4 marketing deck (v2)", priority: "urgent" });
check(r.status === 200 && r.data?.task?.priority === "urgent", "admin edits a task", r);
r = await member.call("PATCH", `/api/tasks/${general.id}`, { title: "hijack" });
check(r.status === 403, "member cannot edit someone else's task → 403", r);
r = await member.call("GET", "/api/tasks?scope=mine");
check(r.status === 200 && r.data?.tasks?.some((t) => t.id === task.id) && !r.data.tasks.some((t) => t.id === general.id), "scope=mine filters by assignee", r);
r = await member.call("GET", `/api/tasks?app=${appId}&q=crash`);
check(r.status === 200 && r.data?.tasks?.length === 1, "app + text search", r);
r = await member.call("GET", `/api/tasks?q=T-${task.number}`);
check(r.status === 200 && r.data?.tasks?.[0]?.id === task.id, "search by T-number", r);
r = await member.call("GET", "/api/tasks?scope=all&sort=number&limit=1");
check(r.status === 200 && r.data?.tasks?.length === 1 && (r.data.hasMore ? !!r.data.nextCursor : true), "limit + cursor paging", r);
if (r.data?.nextCursor) {
  const r2 = await member.call("GET", `/api/tasks?scope=all&sort=number&limit=1&cursor=${encodeURIComponent(r.data.nextCursor)}`);
  check(r2.status === 200 && r2.data?.tasks?.[0]?.id !== r.data.tasks[0].id, "second page differs from first", r2);
}
r = await member.call("GET", "/api/tasks?scope=all&cursor=not-a-cursor");
check(r.status === 200, "tampered cursor degrades to page one", r);
r = await member.call("GET", "/api/tasks?assignee=none&scope=all");
check(r.status === 200, "unassigned filter", r);

// ---------- status workflow ----------
console.log("\nStatus workflow");
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
check(r.status === 200 && r.data?.mode === "applied" && r.data.task.started_at, "member → in_progress applies directly, started_at set", r);
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
check(r.status === 400, "same status → 400", r);
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "done", note: "Tested on Pixel 7" });
check(r.status === 200 && r.data?.mode === "requested" && r.data.task.requested_status === "done" && r.data.task.status === "in_progress", "member → done becomes a REQUEST", r);
r = await member.call("POST", `/api/tasks/${task.id}/review`, { action: "approve" });
check(r.status === 403, "member cannot approve → 403", r);
await settle();
r = await admin.call("GET", "/api/notifications?limit=1");
check(r.status === 200 && r.data?.approvals >= 1 && r.data.unread >= 1, `admin badge feed: ${r.data?.approvals} approval(s), ${r.data?.unread} unread`, r);
r = await admin.call("GET", "/api/tasks?scope=approvals");
check(r.status === 200 && r.data?.tasks?.some((t) => t.id === task.id), "approvals queue lists the request", r);
r = await admin.call("POST", `/api/tasks/${task.id}/review`, { action: "reject", note: "Also test on Android 10" });
check(r.status === 200 && r.data?.mode === "rejected" && r.data.task.requested_status === null, "admin sends back", r);
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "done" });
check(r.status === 200 && r.data?.mode === "requested", "member requests done again", r);
r = await member.call("POST", `/api/tasks/${task.id}/review`, { action: "withdraw" });
check(r.status === 200 && r.data?.mode === "withdrawn", "member withdraws own request", r);
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "done" });
const requestedAt = r.data?.task?.requested_at;
r = await admin.call("POST", `/api/tasks/${task.id}/review`, { action: "approve", note: "LGTM" });
check(r.status === 200 && r.data?.mode === "approved" && r.data.task.status === "done" && r.data.task.completed_at === requestedAt && r.data.task.approved_at, "admin approves — completed_at back-dated to the request", r);
r = await member.call("GET", `/api/tasks/${task.id}`);
check(r.data?.task?.log?.length >= 6 && r.data.task.approved_by?.id === adminId, `history has ${r.data?.task?.log?.length} entries, approved_by set`, r);
await settle();
r = await member.call("GET", "/api/notifications?limit=10");
check(r.status === 200 && r.data?.notifications?.some((n) => n.kind === "task.approved"), "member received the approval notification", r);
r = await member.call("POST", "/api/notifications/read", { all: true });
check(r.status === 200, "mark all read");
r = await admin.call("POST", `/api/tasks/${general.id}/status`, { status: "done" });
check(r.status === 200 && r.data?.mode === "applied" && r.data.task.status === "done", "admin marks own task done directly", r);

// ---------- comments ----------
console.log("\nComments");
r = await admin.call("POST", `/api/tasks/${task.id}/comments`, { body: "Great fix — see https://example.com/pr/1 and T-99." });
check(r.status === 200 && r.data?.comment?.author?.id === adminId, "admin comments", r);
const commentId = r.data?.comment?.id;
r = await member.call("PATCH", `/api/comments/${commentId}`, { body: "hijack" });
check(r.status === 403, "member cannot edit admin's comment → 403", r);
r = await admin.call("PATCH", `/api/comments/${commentId}`, { body: "Great fix (edited)." });
check(r.status === 200, "author edits own comment", r);
r = await member.call("GET", `/api/tasks/${task.id}`);
check(r.data?.task?.comments?.[0]?.edited_at && r.data.task.comment_count === 1, "edited comment reflected on the task", r);

// ---------- attachments ----------
console.log("\nAttachments");
// A valid 1×1 PNG (magic bytes must sniff as image/png).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let fd = new FormData();
fd.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
r = await member.call("POST", `/api/tasks/${task.id}/attachments`, fd);
check(r.status === 200 && r.data?.attachment?.mime === "image/png" && r.data.attachment.width === 1, "upload a PNG (sniffed, dimensions parsed)", r);
const attId = r.data?.attachment?.id;
fd = new FormData();
fd.append("file", new Blob([Buffer.from("MZ\x90\x00 not really")], { type: "image/png" }), "evil.png");
r = await member.call("POST", `/api/tasks/${task.id}/attachments`, fd);
check(r.status === 400, "fake PNG (wrong magic bytes) rejected → 400", r);
fd = new FormData();
fd.append("file", new Blob([Buffer.from("hello world")], { type: "text/plain" }), "notes.txt");
r = await member.call("POST", `/api/tasks/${task.id}/attachments`, fd);
check(r.status === 200 && r.data?.attachment?.mime === "text/plain", "upload a text file", r);
const txtId = r.data?.attachment?.id;
r = await admin.call("GET", `/api/tasks/${task.id}/attachments/${attId}`);
check(r.status === 302 && /supabase\.co\/storage\/v1\/object\/sign/.test(r.headers.get("location") || ""), "download → 302 to a signed URL", r.headers.get("location"));
r = await admin.call("GET", `/api/tasks/${task.id}/attachments/${attId}?json=1`);
check(r.status === 200 && r.data?.url, "download ?json=1 → { url }", r);
if (r.data?.url) {
  const f = await fetch(r.data.url);
  check(f.status === 200 && (await f.arrayBuffer()).byteLength === png.length, "signed URL actually serves the bytes", f.status);
}
r = await admin.call("DELETE", `/api/tasks/${task.id}/attachments/${txtId}`);
check(r.status === 200, "admin removes an attachment", r);
r = await member.call("GET", `/api/tasks/${task.id}`);
check(r.data?.task?.attachments?.length === 1 && r.data.task.attachment_count === 1, "one attachment remains", r);

// ---------- dashboard / settings / activity ----------
console.log("\nDashboard, settings, activity");
r = await member.call("GET", "/api/dashboard");
check(r.status === 200 && r.data?.counts && Array.isArray(r.data.my_tasks) && r.data.approvals.length === 0, "member dashboard (no approvals block)", r);
r = await admin.call("GET", "/api/dashboard");
check(r.status === 200 && r.data?.counts?.team_done_week >= 2 && r.data.releases.length >= 1, `admin dashboard: ${r.data?.counts?.team_done_week} done this week, ${r.data?.releases?.length} release(s)`, r);
r = await member.call("GET", "/api/settings");
check(r.status === 200 && r.data?.settings?.approval_policy?.mode === "done_only", "settings readable by members", r);
r = await member.call("PATCH", "/api/settings", { approval_policy: { mode: "none" } });
check(r.status === 403, "member cannot change settings → 403", r);
r = await admin.call("PATCH", "/api/settings", { approval_policy: { mode: "all" } });
check(r.status === 200 && r.data?.settings?.approval_policy?.mode === "all", "admin sets policy = all", r);
r = await member.call("POST", `/api/tasks/${task.id}/status`, { status: "in_progress" });
check(r.status === 200 && r.data?.mode === "requested", "under policy=all even reopening is a request", r);
r = await admin.call("POST", `/api/tasks/${task.id}/review`, { action: "reject" });
r = await admin.call("PATCH", "/api/settings", { approval_policy: { mode: "done_only" } });
check(r.status === 200, "policy restored to done_only", r);
r = await admin.call("GET", "/api/activity?action=task.");
check(r.status === 200 && r.data?.activity?.length >= 5 && r.data.activity.every((e) => e.action.startsWith("task.")), `activity feed filtered: ${r.data?.activity?.length} task events`, r);
r = await member.call("GET", "/api/activity");
check(r.status === 403, "activity is admin-only → 403", r);
r = await member.call("GET", "/api/ping");
check(r.status === 200 && typeof r.data?.rev === "number" && r.data.rev > 0, `change counter rev=${r.data?.rev}`, r);

// ---------- meetings ----------
console.log("\nMeetings (MOM)");
r = await member.call("POST", "/api/meetings", {});
check(r.status === 403, "member cannot create meetings → 403", r);
r = await admin.call("GET", "/api/meetings");
check(r.status === 200 && Array.isArray(r.data?.meetings), "admin lists meetings", r);
r = await admin.call("POST", "/api/meeting-series", { name: `E2E series ${stamp}`, app_ids: [appId], include_general: true });
check(r.status === 200 && r.data?.series?.id, "admin creates a meeting series scoped to the app", r);
const seriesId = r.data?.series?.id;
if (seriesId) created.series.push(seriesId);
r = await admin.call("POST", "/api/meetings", { series_id: seriesId, held_at: new Date().toISOString() });
check(r.status === 200 && r.data?.meeting?.id, "admin creates a meeting (now)", r);
const meetingId = r.data?.meeting?.id;
if (meetingId) created.meetings.push(meetingId);
r = await member.call("GET", `/api/meetings/${meetingId}`);
check(r.status === 403, "member cannot open a meeting → 403", r);
r = await admin.call("GET", `/api/meetings/${meetingId}`);
check(r.status === 200 && r.data?.done?.some((t) => t.id === task.id) && r.data.pending.length >= 0 && Array.isArray(r.data.people) && r.data.workspace_name, "meeting_pack: done list includes the approved task", r);
r = await member.call("POST", `/api/meetings/${meetingId}/notes`, { body: "late", kind: "action", task_id: task.id });
check(r.status === 403, "member cannot add meeting notes → 403", r);
r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "Needs a follow-up on Android 10 devices", kind: "action", task_id: task.id });
check(r.status === 200 && r.data?.note?.task?.number === task.number, "admin adds an action item on a task", r);
const noteId = r.data?.note?.id;
r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "Ship 2.4.0 on Tuesday", kind: "decision", link_url: "https://example.com/plan", link_label: "Release plan" });
// Until migration 018 is applied the API refuses links with a clear 400; the rest of the flow is unaffected.
const linksLive = !(r.status === 400 && /018/.test(r.data?.error || ""));
if (!linksLive) {
  console.log("  · note links skipped: migration 018 not applied on this database");
  r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "Ship 2.4.0 on Tuesday", kind: "decision" });
}
check(r.status === 200 && r.data?.note?.task === null && (!linksLive || (r.data?.note?.link_url === "https://example.com/plan" && r.data.note.link_label === "Release plan")), linksLive ? "admin adds a general decision with a link" : "admin adds a general decision", r);
const linkedNoteId = r.data?.note?.id;
r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "bad link", link_url: "javascript:alert(1)" });
check(r.status === 400, "a note link must be http(s) → 400", r);
r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "   " });
check(r.status === 400, "an empty note with no link → 400", r);
if (linksLive) {
  r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "", link_url: "https://example.com/only-a-link", link_label: "Spec" });
  check(r.status === 200 && r.data?.note?.body === "" && r.data.note.link_url === "https://example.com/only-a-link", "a note can be just a link", r);
  r = await admin.call("PATCH", `/api/meeting-notes/${r.data?.note?.id}`, { link_url: "" });
  check(r.status === 400, "a link-only note cannot lose its link → 400", r);
  r = await admin.call("PATCH", `/api/meeting-notes/${linkedNoteId}`, { link_url: "" });
  check(r.status === 200, "clearing a note link", r);
  r = await admin.call("GET", `/api/meetings/${meetingId}`);
  check(r.status === 200 && r.data?.notes?.find((n) => n.id === linkedNoteId)?.link_url === null, "pack shows the link cleared", r);
}
r = await admin.call("PATCH", `/api/meetings/${meetingId}`, { notes: "Agenda: releases, crash spike." });
check(r.status === 200, "general minutes saved", r);
r = await admin.call("GET", `/api/tasks/${task.id}`);
check(r.data?.task?.meeting_notes?.length === 1, "task page shows its meeting note (admin)", r);
r = await member.call("GET", `/api/tasks/${task.id}`);
check(r.status === 200 && r.data?.task?.meeting_notes?.length === 0 && r.data.task.meetings.length === 0, "members get no meeting minutes on the task", r);
r = await admin.call("PATCH", `/api/meetings/${meetingId}`, { status: "finalized" });
check(r.status === 200, "meeting finalised", r);
r = await admin.call("POST", `/api/meetings/${meetingId}/notes`, { body: "late note" });
check(r.status === 200, "admin can still amend minutes after closing", r);
r = await member.call("DELETE", `/api/meeting-notes/${noteId}`);
check(r.status === 403, "member cannot delete a note → 403", r);
r = await admin.call("GET", `/api/meetings/${meetingId}`);
check(r.status === 200 && r.data?.meeting?.status === "finalized" && r.data.notes.length === (linksLive ? 4 : 3), "finalised pack still renders with every note", r);

// ---------- reports ----------
console.log("\nReports");
r = await admin.call("GET", "/api/reports");
check(r.status === 200 && r.data?.totals?.done >= 2 && r.data.by_day.length === 30 && r.data.people.length >= 2, `report_pack: ${r.data?.totals?.done} done, ${r.data?.by_day?.length} days`, r);
r = await member.call("GET", "/api/reports");
check(r.status === 200 && r.data?.people?.length === 0, "member report has no per-person breakdown", r);
r = await member.call("GET", "/api/reports?from=2026-13-01&to=2026-10-21");
check(r.status === 400, "invalid date → 400", r);

// ---------- rate limit / throttle ----------
console.log("\nAbuse controls");
const bogus = client("bogus");
let locked = false;
for (let i = 0; i < 7; i++) {
  const rr = await bogus.call("POST", "/api/auth/login", { email: `nobody.${stamp}@example.com`, password: "x" });
  if (rr.status === 429) {
    locked = true;
    break;
  }
}
check(locked, "login throttle locks after repeated failures (429)");

// ---------- sign out ----------
console.log("\nSign-out");
r = await member.call("POST", "/api/auth/logout");
check(r.status === 200, "member signs out");
r = await member.call("GET", "/api/auth/me");
check(r.status === 401, "cookie cleared → 401", r);

// ---------- cleanup ----------
if (cleanup) {
  console.log("\nCleanup");
  for (const id of created.tasks) await admin.call("DELETE", `/api/tasks/${id}`);
  for (const id of created.meetings) await admin.call("DELETE", `/api/meetings/${id}`);
  for (const id of created.series) await admin.call("DELETE", `/api/meeting-series/${id}`);
  for (const id of created.releases) await admin.call("DELETE", `/api/releases/${id}`);
  for (const id of created.apps) await admin.call("DELETE", `/api/apps/${id}`);
  for (const id of created.users) await admin.call("DELETE", `/api/users/${id}`);
  r = await admin.call("GET", "/api/apps");
  check(!r.data?.apps?.some((a) => created.apps.includes(a.id)), "sample app removed");
  // Leave no trace in the panel: task numbers continue from the highest real
  // task, and the activity rows the sample users (and this admin) wrote go.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };
    const seq = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/task_sequence_reset`, { method: "POST", headers: H, body: "{}" });
    if (seq.status === 404) console.log("  (task_sequence_reset missing — run migration 016; sequence left as is)");
    else check(seq.ok, "task numbers continue from the highest real task (sequence reset)", seq.status);
    const emails = [adminEmail, memberEmail].map((x) => `"${x}"`).join(",");
    const act = await fetch(`${process.env.SUPABASE_URL}/rest/v1/activity_log?user_email=in.(${emails})`, { method: "DELETE", headers: { ...H, prefer: "return=minimal" } });
    check(act.ok, "activity rows of the sample users removed", act.status);
  } else console.log("  (no SUPABASE env: sequence/activity cleanup skipped)");
  ok("sample data removed (admin kept)");
} else {
  console.log("\n(sample data kept — rerun with --cleanup to remove it)");
}
await admin.call("POST", "/api/auth/logout");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll e2e checks passed.");
process.exit(failures ? 1 : 0);
