import { getSessionUser } from "./auth";
import { getSupabase } from "./supabase";

interface ActivityInput {
  action: string; // e.g. "task.create", "task.approve", "user.invite"
  entityType?: string; // task | app | release | meeting | user | settings
  entityId?: string;
  summary?: string; // human-readable description shown in the log
  metadata?: Record<string, unknown>;
  ip?: string;
  /** Override the actor (e.g. login, where the session cookie isn't set yet, or cron/system). */
  actor?: { id?: string | null; email?: string | null };
}

/**
 * Record a single user/system action. Best-effort: never throws, never blocks
 * the main operation if logging fails.
 */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    let actorId: string | null = input.actor?.id ?? null;
    let actorEmail: string | null = input.actor?.email ?? null;
    if (!input.actor) {
      const u = await getSessionUser();
      actorId = u?.uid ?? null;
      actorEmail = u?.email ?? null;
    }
    await getSupabase()
      .from("activity_log")
      .insert({
        user_id: actorId,
        user_email: actorEmail ?? "system",
        action: input.action,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        summary: input.summary ?? null,
        metadata: input.metadata ?? null,
        ip: input.ip ?? null,
      });
  } catch (e) {
    console.error("[activity] log failed:", input.action, e);
  }
}

/**
 * Keep the activity log to a rolling window: delete entries older than `days`
 * (default 14). Best-effort — never throws, never blocks a sync. Uses the
 * (created_at) index, so it's an efficient range delete regardless of size.
 */
export async function purgeOldActivity(days = 14): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const sb = getSupabase();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await Promise.all([
      sb.from("activity_log").delete().lt("created_at", cutoff),
      // The two throttle sweeps run sequentially — they overlap on week-old
      // `rl:` rows, and two concurrent deletes on the same table shouldn't race.
      (async () => {
        // Rate-limit counters (`rl:` keys in auth_throttle) are minute-bucketed
        // and otherwise never cleaned — without this the table grows one row per
        // user/action/minute forever. A day of history covers every window.
        await sb.from("auth_throttle").delete().like("key", "rl:%").lt("updated_at", dayAgo);
        // Stale login-throttle rows (`email:`/`ip:` keys): cleared on successful
        // sign-in, but failed-only keys linger forever. Anything untouched for
        // the full window is dead weight — the fail counter decays after 24h and
        // locks cap at 6h, so a week-stale row can never hold an active lock.
        await sb.from("auth_throttle").delete().lt("updated_at", cutoff);
      })(),
    ]);
  } catch (e) {
    console.error("[activity] purge failed:", e);
  }
}
