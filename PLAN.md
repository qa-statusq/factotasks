# FactoTasks — Architecture & Phase Plan

Task tracking for the **mobile app team** (Android · iOS · design · QA · backend · web ·
marketing): per-app and general tasks, member status updates with **admin approval**, exact
time tracking, version-wise **release log** per platform, attachments, and a weekly-meeting
**MOM presentation view** that carries pending work forward week to week.

Built for up to **50 teammates** on a **zero-cost** stack, fast on first load and on phones.

---

## 1. Stack (same family as FactoReviews — nothing new to learn or pay for)

| Piece                | Choice                                               | Cost | Why |
|----------------------|------------------------------------------------------|------|-----|
| App + API            | **Next.js 16** (App Router, `proxy.ts`) on **Firebase App Hosting** (Cloud Run, `minInstances: 0`) | $0 at team scale (Blaze plan needed, scales to zero) | Already deployed this way for FactoReviews; SSR + API routes + per-request CSP nonce |
| Database             | **Supabase Postgres** (free tier: 500 MB)            | $0 | A 50-person team produces a few MB/year of tasks; aggregation lives in SQL functions (one round trip per screen) |
| Attachments          | **Supabase Storage** private bucket (free: 1 GB, 5 GB egress/mo) | $0 | Signed 10-minute download URLs; images are downscaled in the browser before upload (a 4 MB phone screenshot becomes ~250 KB) |
| Auth                 | Own email + password, scrypt hashes, signed JWT cookie (`httpOnly`, `SameSite=Strict`) | $0 | No third-party auth bill; token_version revocation; DB login throttle |
| Realtime-ish updates | Focus/online revalidation + a 45 s poll of ONE tiny `rev` counter while the tab is visible | $0 | 50 users × 1 tiny read/45 s is nothing; no WebSocket infra, no anon key in the browser |
| Email (optional)     | Not required. Daily due-date digest can be added later via Resend free tier (3k/mo) | $0 | In-app notifications cover the core flows |

Why not Vercel Hobby: its terms exclude commercial use; App Hosting has no such limit and is
already set up for this team. Why not Firestore: the MOM/report aggregations (carry-forward
counts, per-person durations) are relational queries — Postgres does them in one call.

### Performance posture (carried over from the FactoReviews optimisation passes)
- Every screen = **one aggregate RPC** (`dashboard_pack`, `apps_overview`, `team_overview`,
  `meeting_pack`, `report_pack`) returning a small JSON blob; lists use keyset pagination.
- Client **stale-while-revalidate cache** with sessionStorage snapshot of hot keys → repeat
  visits and reloads paint instantly, revalidate silently; hover/pointer-down prefetch of the
  next screen's data; 10 s in-instance auth cache + single-flight dedupe on the server.
- `content-visibility` on long lists, variable font (one woff2), code-split heavy screens
  (presentation view, reports), no UI library (hand-rolled primitives, ~0 dependency weight).
- Strict CSP (nonce + `strict-dynamic`), HSTS, COOP/CORP, no-store on every dynamic response,
  RLS on every table with zero policies + revoked PostgREST grants (service role only).

---

## 2. Data model (see `supabase/schema.sql`)

```
users ─────────┬── app_members ──── apps ──── releases
  │            │                     │           │
  │            └── task_assignees ── tasks ──────┘ (task_targets.release_id)
  │                                   ├── task_status_log   (every change / request / approve / reject)
  │                                   ├── task_comments
  │                                   ├── task_attachments  (object key in private bucket)
  │                                   └── meeting_notes ──── meetings (weekly MOM)
  ├── notifications
  └── activity_log (audit)            app_settings (approval policy, workspace name, rev counter)
```

**Task lifecycle & time tracking** (all server-side, atomic in `task_apply_status`):

All durations are office working time — `work_seconds()`: Mon–Fri, 09:00–13:00 and 13:45–18:45 IST.

| Field            | Set when                                   | Meaning |
|------------------|--------------------------------------------|---------|
| `created_at`     | task created                               | lead-time start |
| `started_at`     | first time status becomes `in_progress`    | work start |
| `active_seconds` | every time the task LEAVES `in_progress`   | working time in "in progress" (pauses on hold don't count; an approved stint ends at the request) |
| `completed_at`   | done (direct) / **request time** if approved later | when the work was actually finished |
| `approved_at`    | admin approves                             | approval wait = working time `completed_at → approved_at` |

**Approval workflow** — a member's change is parked in `requested_status` (+ note); the task
keeps its current status until an admin **approves** (applied, logged, completion back-dated to
the request) or **rejects** (cleared, reason logged, requester notified). Admins change status
directly. Policy (`app_settings.approval_policy`): `done_only` (default), `all`, or `none`.

**Carry-forward** (MOM): for a pending task, `carry` = number of earlier meetings held after
the task was created and before it was completed — computed, never stored, so it is always
right even when meetings are added or backdated. Finalised meetings render "as of" their time.

---

## 3. Roles & permissions

| Action                                   | Member                                   | Admin |
|------------------------------------------|------------------------------------------|-------|
| View apps / tasks / releases / meetings / team directory | ✓ (whole team is visible — transparency) | ✓ |
| Create task, assign teammates            | ✓                                        | ✓ |
| Edit task fields                         | creator or assignee                      | ✓ any |
| Change status                            | creator/assignee → **approval per policy** | ✓ direct |
| Approve / reject                         | –                                        | ✓ |
| Comment / attach                         | ✓ (delete own)                           | ✓ |
| Delete task                              | creator (only while `todo`)              | ✓ |
| Apps, members, releases                  | releases: app members may add/edit       | ✓ |
| Meetings (create/finalise), MOM notes    | notes: ✓                                 | ✓ |
| Team (invite, role, reset, deactivate), Settings, Activity | –                       | ✓ |

---

## 4. Screens

`/` Dashboard · `/tasks` (list, filters, board) · `/tasks/[id]` · `/apps` · `/apps/[id]`
(Tasks · Releases · Members · Settings) · `/releases` · `/approvals` (admin) · `/meetings` ·
`/meetings/[id]` · `/meetings/[id]/present` (full-screen MOM deck) · `/reports` · `/team` ·
`/activity` (admin) · `/settings` (admin) · `/profile` · `/login` · `/set-password`

---

## 5. Phases — status after the first build session (2026-10-21)

### Phase 1 — Foundation ✅ done
Scaffold, indigo design system, CSP/security proxy, offline fallback, PWA manifest, schema +
RPCs verified in PGlite (`npm run test-schema`), auth (bootstrap admin, forced password set,
change, sign-out, throttle), team directory + admin management, apps CRUD + members, tasks
(global composer, filterable keyset-paged list, detail page, inline edit, status workflow with
approval queue, timeline, comments, time tracking), dashboard, activity log, profile, settings.

### Phase 2 — Releases, attachments, notifications ✅ done
Releases per app/platform with pipeline status + release notes + linked tasks + cross-app
timeline; attachments (15 MB cap, magic-byte sniffing, private bucket, signed URLs, client-side
image downscale, drag & drop); in-app inbox with unread badge + tab-title count; daily cron
route for due-date reminders + housekeeping.

### Phase 3 — Meetings (MOM) & reports ✅ done
Meeting creation at the configured weekly slot, per-task minutes (note / decision / action /
blocker), general minutes, finalise/reopen, the full-screen **presentation deck** (keyboard,
touch, click zones, fullscreen, print-to-PDF stylesheet), reports with day series / donuts /
per-person & per-app bars + CSV export.

### Phase 4 — Polish & scale (partly done)
- ✅ Live updates (45 s change-counter poll), keyboard shortcuts, help guide
- ⬜ Kanban board view with drag-to-status (honouring the approval policy)
- ⬜ Bulk actions, saved filters
- ✅ Verified against the real Supabase project: `scripts/e2e-api.mjs` drives 100+ API checks
  (admin + member, every flow) and every screen was eyeballed in Chrome
- ⬜ Audit pass (security / performance / a11y / old-browser compat) against the FactoReviews
  checklist
- ⬜ Deploy via `DEPLOY.md` (GitHub → Firebase App Hosting), add real apps and teammates
