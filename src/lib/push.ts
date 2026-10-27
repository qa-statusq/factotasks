import webpush from "web-push";
import { getSupabase } from "./supabase";

/**
 * Browser push (Web Push / VAPID). Zero-cost: the browser vendors' push
 * services deliver it; we only sign the request. Configured when the three
 * VAPID env vars are present; silently a no-op otherwise, so the panel never
 * depends on it.
 */
let configured: boolean | null = null;
function ready(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!pub || !priv) return (configured = false);
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } catch (e) {
    console.error("[push] bad VAPID configuration:", e);
    configured = false;
  }
  return configured;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap lands (same-origin path). */
  url?: string;
  /** Collapses repeated notifications about the same thing. */
  tag?: string;
}

export interface PushResult {
  /** Devices the push service accepted the message for. */
  sent: number;
  /** Devices it refused for a passing reason (network, rate limit). */
  failed: number;
  /** Subscriptions it said can never work again — removed. */
  removed: number;
}

/** Send to every subscription of the given users. Subscriptions the push
 * service rejects for good (expired 404/410, or signed for another key 401/403)
 * are removed — the device re-registers itself on its next visit. Successful
 * deliveries stamp last_used. Never throws. */
export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (!userIds.length || !ready()) return result;
  try {
    const sb = getSupabase();
    const { data: subs } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", userIds);
    if (!subs?.length) return result;
    const body = JSON.stringify(payload);
    const dead: string[] = [];
    const delivered: string[] = [];
    // A few at a time: one instance should never hold hundreds of sockets open.
    const queue = [...subs];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } }, body, { TTL: 60 * 60 * 24, urgency: "high" });
          delivered.push(s.id as string);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410 || code === 401 || code === 403) dead.push(s.id as string);
          else {
            result.failed++;
            console.error("[push] send failed:", code ?? e);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    result.sent = delivered.length;
    result.removed = dead.length;
    await Promise.all([
      dead.length ? sb.from("push_subscriptions").delete().in("id", dead) : null,
      delivered.length ? sb.from("push_subscriptions").update({ last_used: new Date().toISOString() }).in("id", delivered) : null,
    ]);
  } catch (e) {
    console.error("[push] fan-out failed:", e);
  }
  return result;
}
