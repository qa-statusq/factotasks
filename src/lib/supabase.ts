import { createClient, SupabaseClient } from "@supabase/supabase-js";

// NOTE: the global-WebSocket polyfill this module used to carry now lives in
// src/instrumentation.ts. supabase-js constructs a Realtime client we never use,
// and its constructor THROWS when no WebSocket global exists — but doing the
// polyfill here forced a top-level await into a module that scripts/*.mts
// import through tsx, whose CJS transform rejects TLA outright (it broke
// npm run test-env-sync). Next runs instrumentation once at server startup,
// before any request reaches getSupabase(), which is the correct place for
// process-wide runtime setup and keeps this module plain and synchronous.

let cached: SupabaseClient | null = null;

/**
 * Server-side Supabase client using the service-role key.
 * Never import this into a Client Component.
 */
export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
