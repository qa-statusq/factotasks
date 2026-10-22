# Deploying FactoTasks to Firebase App Hosting

Same recipe as FactoReviews (Next.js SSR + API routes + proxy → Firebase App Hosting on
Cloud Run). App Hosting deploys from a **GitHub repo** and rebuilds on every push to the
chosen branch. Secrets live in **Google Secret Manager**.

> Requires the Firebase project to be on the **Blaze** (pay-as-you-go) plan. With
> `minInstances: 0` and a 50-person team the service scales to zero between uses and stays
> within the free allowances.

## 0. One-time tooling
```powershell
npm install -g firebase-tools
firebase login
```

## 1. Put the code in a GitHub repo
```powershell
cd E:\Web-Projects\FactoTasks
git init
git add .
git commit -m "FactoTasks — initial"
# create an EMPTY private repo on github.com first, then:
git remote add origin https://github.com/<org>/factotasks.git
git branch -M main
git push -u origin main
```
`.env*` is gitignored; nothing secret is committed.

## 2. Point `apphosting.yaml` at your Supabase project
Edit the `SUPABASE_URL` value in [`apphosting.yaml`](apphosting.yaml) (non-secret) and commit.
Also paste your **public** VAPID key into `NEXT_PUBLIC_VAPID_PUBLIC_KEY` there (the pair is
generated once with `npx web-push generate-vapid-keys`; the private half is a secret, see §4).
Without it the "Notifications" toggle on Profile reports push as not configured.

## 3. Create the backend
Firebase Console → **App Hosting** → *Get started* → connect the GitHub repo, branch `main`,
root `/`. Or:
```powershell
firebase apphosting:backends:create --project <your-project>
```
(Region `asia-southeast1`, backend id `factotasks`.)

## 4. Secrets (run once each; paste the value from `.env.local`)
```powershell
firebase apphosting:secrets:set SUPABASE_SERVICE_ROLE_KEY
firebase apphosting:secrets:set AUTH_SECRET
# Optional: XFF_TRUSTED_HOPS=1 if a load balancer in front of App Hosting appends
# its own address to X-Forwarded-For (the login throttle keys on the client IP;
# default 0 = the last entry is the client).
firebase apphosting:secrets:set CRON_SECRET
firebase apphosting:secrets:set VAPID_PRIVATE_KEY
```
Then grant BOTH App Hosting service accounts access in one shot (the account running this
needs `roles/secretmanager.admin`):
```powershell
firebase apphosting:secrets:grantaccess SUPABASE_SERVICE_ROLE_KEY,AUTH_SECRET,CRON_SECRET,VAPID_PRIVATE_KEY --backend factotasks --project <your-project>
```
Look for `Successfully set IAM bindings on secret …` for all four. Missing this step makes
every build fail with *"Error resolving secret version … versions/latest"*.

## 5. Deploy
Push to `main` — App Hosting builds and rolls out (first build takes a few minutes). You get a
URL like `https://factotasks--<project>.<region>.hosted.app`. To redeploy: `git push`.

## 6. Smoke test
- Open the URL → redirected to **/login**.
- Sign in as the admin (`npm run create-admin` locally against the same Supabase project, or
  bootstrap with `APP_PASSWORD` locally first).
- Add an app, a teammate, a task; request Done as the teammate; approve as admin; open
  **Meetings → Start this week's meeting → Present**.

## 7. Daily job — Cloud Scheduler (needed)
App Hosting has no built-in cron. The daily job sends due-date reminders (09:00 IST) and is
what keeps the Activity log at 90 days and the inbox at 60 days — without it they grow
without bound. Replace `<APP_URL>` and `<CRON_SECRET>`:
```powershell
gcloud scheduler jobs create http factotasks-daily `
  --location=asia-southeast1 `
  --schedule="0 9 * * *" `
  --time-zone="Asia/Kolkata" `
  --uri="<APP_URL>/api/cron/daily" `
  --http-method=GET `
  --headers="Authorization=Bearer <CRON_SECRET>"
```
The route rejects any request without the correct bearer token, so it is safe to be public.

## 8. Custom domain (optional)
App Hosting → backend → **Add custom domain**, follow the DNS steps. HSTS is already on.

## 9. Housekeeping
- Rotate any secret that was ever pasted in plaintext before going wide.
- Supabase: confirm **RLS is enabled on every table** (schema.sql does this) and that the
  `attachments` bucket is **private** (`npm run check` reports both).
- Free-tier watch-points: Supabase 500 MB DB / 1 GB storage / 5 GB egress per month. Images
  are downscaled before upload, so a busy team uses a few hundred MB a year.
