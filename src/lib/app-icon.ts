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

export async function fetchPlayIcon(packageName: string): Promise<string | null> {
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

export async function fetchAppStoreIcon(bundleId: string): Promise<string | null> {
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

/**
 * App Store first: its artwork is always the plain square icon. Play's
 * og:image is whatever asset the listing uploaded, which sometimes carries a
 * wordmark or padding — fine as a fallback, not as the first choice.
 */
export async function resolveAppIcon(androidPackage: string | null | undefined, iosBundleId: string | null | undefined): Promise<string | null> {
  if (iosBundleId) {
    const icon = await fetchAppStoreIcon(iosBundleId);
    if (icon) return icon;
  }
  if (androidPackage) {
    const icon = await fetchPlayIcon(androidPackage);
    if (icon) return icon;
  }
  return null;
}

// Apps created before icons existed (or whose first fetch failed) get one
// filled in lazily: the first list request after boot kicks off a fetch per
// app, at most once per process, without delaying the response. The apps
// trigger bumps the change counter, so open tabs pick the icon up on their
// next poll.
const attempted = new Set<string>();
export function backfillAppIcons(
  apps: { id: string; icon_url?: string | null; android_package?: string | null; ios_bundle_id?: string | null }[],
  save: (id: string, iconUrl: string) => Promise<unknown>
): void {
  for (const a of apps) {
    if (a.icon_url || attempted.has(a.id) || (!a.android_package && !a.ios_bundle_id)) continue;
    attempted.add(a.id);
    void resolveAppIcon(a.android_package, a.ios_bundle_id)
      .then((icon) => (icon ? save(a.id, icon) : null))
      .catch(() => null);
  }
}
