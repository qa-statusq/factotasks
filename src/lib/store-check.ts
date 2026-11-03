import { getSupabase } from "./supabase";
import { applyReleased, AlreadyReleased } from "./releases";
import { adminIds, notifyUsers } from "./notify";
import { logActivity } from "./activity";
import { PLATFORM_META, taskRef } from "./domain";
import { appStoreListing, compareVersions, normVersion, playListing, type StoreListing } from "./store-listing";

/** Versions still on their way out: what the store check may mark released. */
const PENDING = ["planned", "in_progress", "testing", "submitted"] as const;
const STORE_NAME = { android: "Google Play", ios: "the App Store" } as const;

type Platform = "android" | "ios";
interface PendingRow {
  id: string;
  app_id: string;
  platform: Platform;
  version_name: string;
  planned_date: string | null;
  app: { name: string; status: string; android_package: string | null; ios_bundle_id: string | null } | null;
}

export interface StoreCheckResult {
  /** Store listings read (one per app + platform that has a version on its way out). */
  checked: number;
  released: { app: string; platform: Platform; version: string; released_at: string; tasks: number }[];
  /** The store is ahead of every version the panel knows — admins were told (once per version). */
  ahead: { app: string; platform: Platform; store: string }[];
  /** Listings that couldn't be read (not public yet, e.g. early access, or the store didn't answer). */
  unreadable: { app: string; platform: Platform }[];
}

/**
 * Compare every version that isn't released yet with what Google Play and the App
 * Store offer right now. A version the store already shows goes through the SAME
 * release rule as clicking "Released" (linked tasks settle, the app team is told),
 * dated when the store published it. Nothing pending → no store is asked anything.
 * `dryRun` reports what would happen and writes nothing.
 */
export async function runStoreCheck({ dryRun = false } = {}): Promise<StoreCheckResult> {
  const sb = getSupabase();
  const result: StoreCheckResult = { checked: 0, released: [], ahead: [], unreadable: [] };
  const { data, error } = await sb
    .from("releases")
    .select("id, app_id, platform, version_name, planned_date, app:apps(name, status, android_package, ios_bundle_id)")
    .in("status", PENDING as unknown as string[]);
  if (error) throw error;
  const rows = ((data || []) as unknown as (Omit<PendingRow, "app"> & { app: PendingRow["app"] | PendingRow["app"][] })[])
    .map((r) => ({ ...r, app: Array.isArray(r.app) ? r.app[0] ?? null : r.app }))
    .filter((r) => r.app && r.app.status !== "archived");

  // One listing per app + platform, however many versions it has queued.
  const groups = new Map<string, PendingRow[]>();
  for (const r of rows) {
    const id = r.platform === "android" ? r.app!.android_package : r.app!.ios_bundle_id;
    if (!id) continue;
    const k = `${r.app_id}:${r.platform}`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  if (!groups.size) return result;

  const jobs = [...groups.values()].map((list) => async () => {
    const { app_id, platform, app } = list[0];
    const listing: StoreListing | null = platform === "android" ? await playListing(app!.android_package!) : await appStoreListing(app!.ios_bundle_id!);
    result.checked++;
    if (!listing) {
      result.unreadable.push({ app: app!.name, platform });
      return;
    }
    const match = list.find((r) => normVersion(r.version_name) === normVersion(listing.version));
    const label = `${app!.name} ${PLATFORM_META[platform].label} v${normVersion(listing.version)}`;
    if (match) {
      const released_at = listing.releasedAt && Date.parse(listing.releasedAt) <= Date.now() ? listing.releasedAt : new Date().toISOString();
      if (dryRun) {
        result.released.push({ app: app!.name, platform, version: match.version_name, released_at, tasks: 0 });
        return;
      }
      try {
        const r = await applyReleased(
          { id: match.id, app_id, platform, version_name: match.version_name, planned_date: match.planned_date, released_at, app_name: app!.name },
          null,
          { kind: "change", note: `live on ${STORE_NAME[platform]}`, completedAt: released_at }
        );
        result.released.push({ app: app!.name, platform, version: match.version_name, released_at, tasks: r.closed.length + r.partial.length });
        const done = r.closed.length ? ` — ${r.closed.map((t) => taskRef(t.number)).join(", ")} marked done` : "";
        await logActivity({
          action: "release.update",
          entityType: "release",
          entityId: match.id,
          actor: { email: "Store check" },
          summary: `Marked ${label} released — live on ${STORE_NAME[platform]}${done}`,
          metadata: { changes: { status: { from: null, to: "released" } }, closed: r.closed.length, store: listing },
        });
        const { data: members } = await sb.from("app_members").select("user_id").eq("app_id", app_id);
        await notifyUsers({
          userIds: [...(members || []).map((m) => m.user_id as string), ...(await adminIds())],
          kind: "release.released",
          message: `${label} is live on ${STORE_NAME[platform]} — marked released${done}`,
        });
      } catch (e) {
        if (!(e instanceof AlreadyReleased)) throw e; // someone marked it a moment ago: nothing to do
      }
      return;
    }
    // Not a version we're waiting for. Tell admins only when the store is AHEAD of
    // everything the panel knows for this app (a version shipped without being logged).
    const { data: known } = await sb.from("releases").select("version_name").eq("app_id", app_id).eq("platform", platform);
    const versions = (known || []).map((k) => k.version_name as string);
    if (versions.some((v) => normVersion(v) === normVersion(listing.version))) return;
    if (versions.some((v) => compareVersions(v, listing.version) >= 0)) return;
    result.ahead.push({ app: app!.name, platform, store: listing.version });
    if (dryRun) return;
    const message = `${platform === "ios" ? "The App Store" : "Google Play"} shows ${label}, which isn't in Releases — add it so its tasks can be tracked`;
    const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("kind", "release.store_ahead").eq("message", message);
    if (count) return; // told once per version
    await notifyUsers({ userIds: await adminIds(), kind: "release.store_ahead", message, url: `/apps/${app_id}` });
  });
  // Two stores, a handful of apps: three at a time keeps a run to a few seconds.
  const worker = async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) await j();
  };
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return result;
}
