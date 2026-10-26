import { createClient, SupabaseClient } from "@supabase/supabase-js";

// The global-WebSocket polyfill supabase-js needs at construction lives in
// src/instrumentation.ts (run once at server startup), so this module stays
// plain and synchronous.

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
