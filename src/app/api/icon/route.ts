import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";
import { clientIp } from "@/lib/throttle";

export const dynamic = "force-dynamic";

/**
 * Store-icon relay. App tiles load their Play / App Store artwork through
 * here instead of straight from the store CDNs, which are slow or refuse now
 * and then and left tiles blank. The relay answers with long cache headers,
 * so the hosting CDN serves every later request itself; an upstream failure
 * is a 502 the tile turns into its lettered fallback.
 */
const HOSTS = [/^play-lh\.googleusercontent\.com$/, /(^|\.)mzstatic\.com$/];
const MAX_BYTES = 2 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("u") || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Bad icon url" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (target.protocol !== "https:" || !HOSTS.some((h) => h.test(target.hostname))) return NextResponse.json({ error: "Icon host not allowed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  // Public path (tiles load before sign-in resolves): one address gets a sane number of misses a minute; hits are served by the CDN.
  const limited = await rateLimited(clientIp(req), "icon", 120, 60);
  if (limited) return limited;
  try {
    // No redirects: an allow-listed host must answer itself, never hand the relay to another one.
    const up = await fetch(target, { headers: { accept: "image/*", "user-agent": "Mozilla/5.0 (FactoTasks icon relay)" }, signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error" });
    const type = up.headers.get("content-type") || "";
    if (!up.ok || !type.startsWith("image/") || !up.body) return NextResponse.json({ error: "Icon unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    const declared = Number(up.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return NextResponse.json({ error: "Icon too large" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    // Read up to the cap and not a byte more.
    const parts: Uint8Array[] = [];
    let got = 0;
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return NextResponse.json({ error: "Icon too large" }, { status: 502, headers: { "Cache-Control": "no-store" } });
      }
      parts.push(value);
    }
    const buf = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.byteLength;
    }
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Icon unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
