/**
 * Store-listing icons, fetched server-side and cached on the app row:
 *  - Google Play: the listing page's og:image (no API key needed).
 *  - App Store: the public iTunes lookup API (artworkUrl512).
 * Best-effort with short timeouts; a failure simply leaves the coloured
 * letter tile in place.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

async function get(url: string, ms = 6000): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, signal: AbortSignal.timeout(ms), cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function fetchPlayIcon(packageName: string): Promise<string | null> {
  if (!/^[a-zA-Z][\w.]*$/.test(packageName)) return null;
  const html = await get(`https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=in`);
  if (!html) return null;
  const m = /<meta\s+property="og:image"\s+content="([^"]+)"/i.exec(html) || /<meta\s+content="([^"]+)"\s+property="og:image"/i.exec(html);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, "&");
  if (!/^https:\/\/play-lh\.googleusercontent\.com\//.test(url)) return null;
  // Ask the CDN for a crisp 256px square (its size suffix convention).
  return `${url.split("=")[0]}=s256`;
}

async function fetchAppStoreIcon(bundleId: string): Promise<string | null> {
  if (!/^[a-zA-Z][\w.-]*$/.test(bundleId)) return null;
  const json = await get(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=in`);
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { results?: { artworkUrl512?: string; artworkUrl100?: string }[] };
    const art = data.results?.[0]?.artworkUrl512 || data.results?.[0]?.artworkUrl100;
    if (!art || !/^https:\/\/[\w.-]*mzstatic\.com\//.test(art)) return null;
    return art.replace(/\/\d+x\d+bb\./, "/256x256bb.");
  } catch {
    return null;
  }
}

interface AppIcons {
  android: string | null;
  ios: string | null;
  /** The app's main tile: the Play icon where the app is on Android, else the App Store artwork. */
  main: string | null;
}

/** Both store icons, fetched side by side; each platform shows its own. */
export async function resolveAppIcons(androidPackage: string | null | undefined, iosBundleId: string | null | undefined): Promise<AppIcons> {
  const [android, ios] = await Promise.all([androidPackage ? fetchPlayIcon(androidPackage) : Promise.resolve(null), iosBundleId ? fetchAppStoreIcon(iosBundleId) : Promise.resolve(null)]);
  return { android, ios, main: android ?? ios };
}

/** The row patch for a fetched icon set (null keeps a column as it was). */
export function iconPatch(icons: AppIcons): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  if (icons.android) patch.icon_android_url = icons.android;
  if (icons.ios) patch.icon_ios_url = icons.ios;
  if (icons.main) patch.icon_url = icons.main;
  return patch;
}

// Apps created before icons existed (or whose first fetch failed) get one
// filled in lazily: the first list request after boot kicks off a fetch per
// app, at most once per process, without delaying the response. The apps
// trigger bumps the change counter, so open tabs pick the icon up on their
// next poll.
const attempted = new Set<string>();
export function backfillAppIcons(
  apps: { id: string; icon_url?: string | null; icon_android_url?: string | null; icon_ios_url?: string | null; android_package?: string | null; ios_bundle_id?: string | null }[],
  save: (id: string, patch: Record<string, string | null>) => Promise<unknown>
): void {
  for (const a of apps) {
    const wantAndroid = !!a.android_package && !a.icon_android_url;
    const wantIos = !!a.ios_bundle_id && !a.icon_ios_url;
    if (attempted.has(a.id) || (!wantAndroid && !wantIos)) continue;
    attempted.add(a.id);
    void resolveAppIcons(wantAndroid ? a.android_package : null, wantIos ? a.ios_bundle_id : null)
      .then((icons) => {
        const patch = iconPatch(icons);
        // The main tile is Android first: an app that only had its App Store art switches once the Play icon arrives.
        if (icons.android) patch.icon_url = icons.android;
        else if (!a.icon_url && icons.ios) patch.icon_url = icons.ios;
        else delete patch.icon_url;
        return Object.keys(patch).length ? save(a.id, patch) : null;
      })
      .catch(() => attempted.delete(a.id)); // a database without 016 yet: try again next boot
  }
}
