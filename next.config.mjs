const isProd = process.env.NODE_ENV === "production";

// NOTE: Content-Security-Policy is set per-request in src/proxy.ts (Next 16's
// rename of the middleware convention) so scripts can use a one-time nonce +
// 'strict-dynamic' (no 'unsafe-inline'). The static headers below apply to
// every response.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // A private team panel: never indexed, even if a crawler ignores robots.txt.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  // Cross-origin isolation: no window.opener handles into the panel, panel
  // resources unusable as cross-site subresources, no Flash/PDF policy files.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["ws"],
  poweredByHeader: false,
  // Strip console.* from PRODUCTION bundles (keep error/warn so serverError's
  // server log survives). Standing guardrail against any future client-side
  // console.log(user/config) shipping verbatim to an attacker reading the bundle.
  compiler: { removeConsole: isProd ? { exclude: ["error", "warn"] } : false },
  // The only next/image source is the local brand mark — effectively immutable.
  images: { minimumCacheTTL: 2678400 },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Authenticated team data must never be served stale from the browser/CDN
      // cache. Always revalidate.
      // Every API path except the store-icon relay, which sets its own header
      // per response (long-lived on success, no-store on failure — a config
      // rule would stamp both the same).
      {
        // (and a task attachment's file, which never changes under its id — see proxy.ts)
        source: "/api/:path((?!icon$|tasks/[^/]+/attachments/[^/]+$).*)",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" }],
      },
      // Brand assets are public, unhashed and effectively immutable.
      {
        source: "/brand/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      // The PWA manifest + offline page: short cache, revalidated in the background.
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }],
      },
    ];
  },
};

export default nextConfig;
