import { NextRequest, NextResponse } from "next/server";

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
  try {
    const up = await fetch(target, { headers: { accept: "image/*", "user-agent": "Mozilla/5.0 (FactoTasks icon relay)" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    const type = up.headers.get("content-type") || "";
    if (!up.ok || !type.startsWith("image/")) return NextResponse.json({ error: "Icon unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    const buf = await up.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return NextResponse.json({ error: "Icon too large" }, { status: 502, headers: { "Cache-Control": "no-store" } });
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
