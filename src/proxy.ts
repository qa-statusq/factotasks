import { NextRequest, NextResponse } from "next/server";
// jose SUBPATH imports, never the "jose" barrel: the barrel re-exports JWE,
// whose deflate helper needs CompressionStream — absent in some runtimes — and
// we only ever verify a JWS here. JWTPayload is a TYPE-only import.
import { jwtVerify } from "jose/jwt/verify";
import type { JWTPayload } from "jose";

const COOKIE = "ft_session";

// Hoisted: same key bytes every request; no need to re-encode per call.
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET);

async function decode(token: string | undefined): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    // Pin the algorithm so a future key-type refactor can't open an alg-confusion hole.
    const { payload } = await jwtVerify(token, SECRET, { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

/**
 * Next 16's "proxy" file convention (the rename of middleware). It is the one
 * request gate: mints the CSP nonce, hardens every dynamically-rendered
 * response, and performs the auth redirect before any route runs.
 */

/**
 * Per-request Content-Security-Policy. In production scripts are locked to a
 * one-time nonce + 'strict-dynamic' (NO 'unsafe-inline') — the strongest
 * practical XSS defense for Next.js. In development script-src is relaxed so
 * HMR / React Fast Refresh keep working.
 */
function buildCsp(nonce: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const scriptSrc = isProd
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Attachment previews are loaded straight from the private bucket via
    // short-lived signed URLs; blob: covers client-side image downscaling.
    // Store-listing app icons come straight from Google's and Apple's CDNs.
    "img-src 'self' data: blob: https://*.supabase.co https://play-lh.googleusercontent.com https://*.mzstatic.com",
    "media-src 'self' blob: https://*.supabase.co",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    // The browser only ever talks to our own API routes — Supabase is reached
    // server-side — so even a successful XSS couldn't exfiltrate data to an
    // attacker origin.
    "connect-src 'self'",
    "object-src 'none'",
    "worker-src 'self'",
  ].join("; ");
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // One nonce per request.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  // The nonce must reach Next on the REQUEST headers so it stamps its own inline
  // scripts; the browser enforces the same policy via the RESPONSE header.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  // Mirror next.config.mjs's securityHeaders VERBATIM: responses crafted here
  // (401 JSON, login redirects) never pass through the router, so next.config's
  // headers() doesn't reach them.
  const harden = (res: NextResponse) => {
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.headers.set("Permissions-Policy", "camera=(), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), browsing-topics=()");
    res.headers.set("X-DNS-Prefetch-Control", "off");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    res.headers.set("X-Permitted-Cross-Domain-Policies", "none");
    if (process.env.NODE_ENV === "production") {
      res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    // Only DYNAMIC responses pass through here (the matcher excludes static
    // assets), so a blanket no-store is correct — it keeps a logged-out Back
    // press from repainting an authed page out of the HTTP/bfcache.
    // The store-icon relay (/api/icon) sets its own long-lived cache header;
    // everything else dynamic is personal and must not be cached.
    if (!pathname.startsWith("/api/icon")) res.headers.set("Cache-Control", "no-store, must-revalidate");
    res.headers.delete("x-powered-by");
    res.headers.delete("x-nextjs-cache");
    res.headers.delete("x-nextjs-prerender");
    res.headers.delete("x-nextjs-stale-time");
    res.headers.delete("x-matched-path");
    return res;
  };
  const rendered = () => harden(NextResponse.next({ request: { headers: requestHeaders } }));
  const withCsp = harden;

  // Public paths. /login is handled below — an authed user is bounced off it.
  // Public: sign-in, the cron hook (secret-checked inside) and the store-icon
  // relay (public artwork; its host allowlist lives in the route).
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron") || pathname.startsWith("/api/icon")) {
    return rendered();
  }

  const payload = await decode(req.cookies.get(COOKIE)?.value);

  // The login screen: signed-in users are redirected away, so Back can never
  // show the login form to an authenticated user.
  if (pathname === "/login") {
    if (payload) {
      const url = req.nextUrl.clone();
      url.pathname = payload.mc === true ? "/set-password" : "/";
      url.search = "";
      return withCsp(NextResponse.redirect(url));
    }
    return rendered();
  }

  // Not signed in.
  if (!payload) {
    if (pathname.startsWith("/api")) {
      return withCsp(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Remember where they were heading (same-origin path only) so sign-in
    // lands on the shared task/meeting link instead of the dashboard.
    const next = `${pathname}${req.nextUrl.search}`;
    url.search = next !== "/" && next.startsWith("/") && !next.startsWith("//") ? `?next=${encodeURIComponent(next)}` : "";
    return withCsp(NextResponse.redirect(url));
  }

  // Mandatory password change (first login / after a reset): block everything
  // except the set-password screen until it's done.
  if (payload.mc === true && pathname !== "/set-password") {
    if (pathname.startsWith("/api")) {
      return withCsp(NextResponse.json({ error: "Password change required" }, { status: 403 }));
    }
    const url = req.nextUrl.clone();
    const wanted = pathname + (req.nextUrl.search || "");
    url.pathname = "/set-password";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(wanted)}` : "";
    return withCsp(NextResponse.redirect(url));
  }

  return rendered();
}

export const config = {
  // Skip ONLY paths that can actually BE static files: Next internals
  // (/_next/*), the /brand/* asset folder, and ROOT-level files with a known
  // static extension ([^/]+ = no slash, so /robots.txt and /icon.png match but
  // nested paths never do). Dynamic routes must always pass through here
  // regardless of how their URL ends.
  matcher: [
    "/((?!_next|brand/|[^/]+\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|txt|xml|json|webmanifest|js|css|map|woff2?|ttf|html)$).*)",
  ],
};
