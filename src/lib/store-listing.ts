/**
 * What the public stores show for an app right now — read server-side, no keys:
 *  - Google Play: the listing page (its "Version" and "Updated on" blocks).
 *  - App Store: the public iTunes lookup API (`version`, `currentVersionReleaseDate`).
 * Best-effort with short timeouts: a listing that can't be read is `null`, never a guess.
 * An app in early access / closed testing has no public listing, so it reads as `null` too.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export async function storeGet(url: string, ms = 6000): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, signal: AbortSignal.timeout(ms), cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

export interface StoreListing {
  /** The version the store offers, e.g. "2.9.6". */
  version: string;
  /** When that version went out (App Store), or the listing's last update (Google Play). */
  releasedAt: string | null;
}

export const playUrl = (pkg: string) => `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=in`;

export async function playListing(packageName: string): Promise<StoreListing | null> {
  if (!/^[a-zA-Z][\w.]*$/.test(packageName)) return null;
  const html = await storeGet(playUrl(packageName), 10_000);
  if (!html) return null;
  // The listing data carries the version as [[["2.9.6"]],[[[minSdk]]…; "Varies with device" never matches.
  const v = /\[\[\["(\d+(?:\.\d+){1,3})"\]\],\[\[\[\d+\]\]/.exec(html);
  if (!v) return null;
  // "Updated on" follows a little later as [["Oct 28, 2026",[<epoch seconds>,<nanos>]]].
  const tail = html.slice(v.index, v.index + 4000);
  const d = /\[\["[A-Z][a-z]{2,8} \d{1,2}, \d{4}",\[(\d{9,11}),\d+\]\]\]/.exec(tail);
  const secs = d ? Number(d[1]) : NaN;
  return { version: v[1], releasedAt: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null };
}

export async function appStoreListing(bundleId: string): Promise<StoreListing | null> {
  if (!/^[a-zA-Z][\w.-]*$/.test(bundleId)) return null;
  const json = await storeGet(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=in`);
  if (!json) return null;
  try {
    const r = (JSON.parse(json) as { results?: { version?: string; currentVersionReleaseDate?: string }[] }).results?.[0];
    if (!r?.version || !/^\d+(\.\d+){0,3}$/.test(r.version)) return null;
    const at = r.currentVersionReleaseDate && !Number.isNaN(Date.parse(r.currentVersionReleaseDate)) ? new Date(r.currentVersionReleaseDate).toISOString() : null;
    return { version: r.version, releasedAt: at };
  } catch {
    return null;
  }
}

/** "v2.9.6 " → "2.9.6": how a version is written in the panel vs. on the store. */
export function normVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/** Dotted numeric compare: 1.10 > 1.9, 2.9 = 2.9.0. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = normVersion(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = normVersion(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
