/**
 * Server startup hook. Next runs `register()` once per runtime, before any
 * request is served — the right place for process-wide setup.
 *
 * Its only job: give supabase-js a global WebSocket when the runtime has none.
 * supabase-js constructs a Realtime client we never use, and its constructor
 * THROWS without one ("Node.js 20 detected without native WebSocket support"),
 * which would take down every route at once.
 *
 * Why it is CONDITIONAL rather than a plain import: `ws` is listed in
 * serverExternalPackages, so it is required from node_modules instead of being
 * bundled — ~197ms of module evaluation, and this deployment scales to zero, so
 * that lands on every first hit after idle. Node 22.4+ ships WebSocket natively
 * (engines.node is pinned to >=22), so in production this import never runs.
 *
 * The check is on the FEATURE, not the version: native WebSocket was only
 * unflagged in 22.4 — absent on 22.0-22.3 — and local development is still on
 * Node 20. Both keep working, at zero cost wherever the global already exists.
 *
 * The NEXT_RUNTIME guard is required, not decorative. Next inlines that value
 * per bundle, so in the Edge bundle this compiles to a constant-false branch and
 * the `ws` import is eliminated as dead code. Without it the edge compiler would
 * try to trace `ws` and report unsupported Node APIs — the same class of
 * warning the jose subpath imports exist to avoid.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined") return;
  const { default: ws } = await import("ws");
  (globalThis as { WebSocket?: unknown }).WebSocket = ws as unknown;
}
