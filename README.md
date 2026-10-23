# FactoTasks — by Version Systems Private Limited

Task tracking for the **mobile app team**: per-app and general tasks, member status updates
with **admin approval**, exact time tracking, a version-wise **release log** (Android + iOS),
attachments, and a weekly-meeting **MOM** that carries pending work forward week to week —
with a full-screen presentation deck.

Built for up to ~50 teammates on a **zero-cost** stack. See [`PLAN.md`](PLAN.md) for the
architecture, data model, permissions and phase plan.

## What it does

- **Tasks** — title, description, app (or *General*), platform (Android / iOS / both), type,
  priority, assignees (many), due date, labels, estimate, release link, comments, attachments.
- **Approval workflow** — members move tasks; marking *Done* (policy-configurable) parks a
  request that an admin **approves** (applied, completion back-dated to the request) or
  **sends back** with a note. Admins change status directly.
- **Time tracking** — created / started / completed / approved timestamps; *active time*
  counts only time spent in *In progress*; lead time and approval wait are shown per task and
  aggregated in Reports.
- **Apps & releases** — apps with platforms and members (developer / designer / QA / lead …);
  releases per platform with status pipeline, planned date, what's in it, internal notes, and
  linked tasks.
- **Weekly meeting (MOM)** — one click creates this week's meeting: done since last time,
  **carried-forward** pending work (with a ×N-weeks badge), new, blocked & overdue, approvals,
  releases, per-app and per-person tables, minutes (note / decision / action / blocker) pinned
  to tasks. **Present** opens a keyboard/touch-driven deck; print to PDF.
- **Team** — directory by department, workload per person; admins invite (temporary
  password, forced change on first sign-in), change roles, reset passwords, deactivate.
- **Inbox** — in-app notifications (assigned, requested, approved/rejected, comments,
  attachments, releases, due-date reminders).
- **Reports** — throughput, lead/active time, by day / type / priority / app / person, CSV.
- **Dashboard**, **Activity** audit log (admin), **Settings** (approval policy, meeting day),
  **Profile**, offline fallback page, installable PWA.

## Architecture (all free tiers)

| Piece          | Tech                                                        | Cost |
|----------------|-------------------------------------------------------------|------|
| App + API      | Next.js 16 on **Firebase App Hosting** (Cloud Run, scale-to-zero) | $0*  |
| Database       | **Supabase** Postgres — aggregation in SQL functions         | $0   |
| Attachments    | **Supabase Storage** private bucket, signed URLs            | $0   |
| Reminders      | **Cloud Scheduler** → `/api/cron/daily` (optional)          | $0*  |

> \* App Hosting requires the Firebase **Blaze** plan, but with `minInstances: 0` the service
> scales to zero and a 50-person team stays within the free allowances.

Every screen is **one aggregate RPC** (`dashboard_pack`, `apps_overview`, `team_overview`,
`meeting_pack`, `report_pack`); lists use keyset pagination; the client keeps a
stale-while-revalidate cache with a sessionStorage snapshot of hot keys, hover prefetch, and a
45-second change-counter poll for live updates.

## Setup

### 1. Supabase
1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: paste [`supabase/schema.sql`](supabase/schema.sql), run.
   Then paste [`supabase/storage.sql`](supabase/storage.sql), run (creates the private
   `attachments` bucket). Both scripts are safe to re-run.
3. **Settings → API**: copy the **Project URL** and the **service_role** key.
4. **Updating an existing project**: every schema change ships twice — as a
   numbered file in [`supabase/migrations/`](supabase/migrations/) (run only the
   ones you haven't applied yet, in order) and folded into `schema.sql` (fresh
   installs run that alone). Both are idempotent.
5. **Push notifications (optional)**: `npx web-push generate-vapid-keys`, put the
   keys in `.env.local` as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
   with `VAPID_SUBJECT=mailto:you@example.com`. Members turn them on under Profile.

### 2. Environment
```bash
cp .env.example .env.local      # then fill in the values
openssl rand -hex 32            # AUTH_SECRET
openssl rand -hex 32            # CRON_SECRET
```

### 3. Run
```bash
npm install
npm run check                   # verifies tables, RPCs, bucket, admin
npm run create-admin -- you@company.com "a-strong-password" First Last
npm run dev                     # http://localhost:3000
```
(Alternatively sign in once with any email + `APP_PASSWORD` to bootstrap the first admin,
then remove `APP_PASSWORD`.)

### 4. Deploy
See [`DEPLOY.md`](DEPLOY.md) — GitHub → Firebase App Hosting, three secrets, optional
Cloud Scheduler job.

## Scripts

| Script                 | What it does |
|------------------------|--------------|
| `npm run dev / build / start` | Next.js |
| `npm run verify`       | typecheck + lint + build (run before every deploy) |
| `npm run test-schema`  | loads `schema.sql` into an in-process Postgres (PGlite), seeds data, exercises every RPC and the approval workflow — no Supabase needed |
| `npm run check`        | verifies the live Supabase project is set up |
| `npm run e2e -- <admin-email> <password> [--cleanup]` | drives every API flow (as admin AND member) against a running dev server + the live DB; `--cleanup` removes the sample data it created |
| `npm run create-admin` | creates / resets an admin account |
| `npm run favicon`      | regenerates brand PNGs from the SVG mark |

## Security
- Email + scrypt-hashed passwords; signed JWT session cookie (`httpOnly`, `SameSite=Strict`,
  `secure` in prod, 7 days). `token_version` revocation on password change / reset /
  deactivation; 10 s in-instance verification cache with single-flight.
- DB-backed login throttle keyed by email + IP (atomic reservation; escalating lockout),
  per-route rate limits, generic auth errors (no enumeration), timing-equalised login.
- Per-request CSP with nonce + `strict-dynamic`, HSTS, COOP/CORP, `X-Frame-Options: DENY`,
  `no-store` on every dynamic response, framework fingerprint headers stripped.
- RLS enabled on every table with no policies + PostgREST grants revoked: the service role
  (server only) is the single reader/writer. The browser never holds a Supabase key.
- Uploads: size cap (15 MB), **magic-byte** type sniffing, generated object keys, private
  bucket, 10-minute signed URLs; images downscaled client-side before upload.
- All text cleaned (control/bidi characters stripped, lengths capped); React-escaped
  rendering; CSV export defuses formula injection.
- Full activity log (14 days) of every action by every user.

## Project layout
```
src/
  app/                 screens (client components) + api/ route handlers
  components/          app shell, task form/composer, lists, release & meeting UI, ui/ primitives
  lib/                 auth, guards, validation, domain vocab, caching, access rules, helpers
  proxy.ts             request gate: CSP nonce, security headers, auth redirect
supabase/schema.sql    full schema, RPCs, triggers, lockdown (re-runnable)
supabase/storage.sql   attachments bucket
scripts/               test-schema (PGlite), check-setup, create-admin, make-icons
```
