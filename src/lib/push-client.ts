"use client";

import { postJson } from "@/lib/http";

/** Browser-side half of push: permission, subscription, and the server sync. */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** serviceWorker.ready never settles where the worker is blocked (private
 * windows, some corporate policies): bound it so the UI can say so. */
async function readyWorker(ms = 6000): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await readyWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Ask permission, subscribe this browser, and register it with the server.
 * Resolves with a message to show, or null on success. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return "This browser doesn't support notifications.";
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "Notifications aren't configured on the server yet.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications were blocked — allow them in the browser's site settings.";
  const reg = await readyWorker();
  if (!reg) return "The browser's background worker isn't available here (private window?).";
  let sub = await reg.pushManager.getSubscription();
  try {
    if (!sub) {
      // Cast: lib.dom types ArrayBuffer-backed views, which Uint8Array satisfies at runtime.
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) as unknown as ArrayBuffer });
    }
  } catch (e) {
    return `This browser refused the subscription${e instanceof Error && e.message ? ` (${e.message})` : ""}.`;
  }
  const json = sub.toJSON();
  const { ok, data } = await postJson("/api/push", { endpoint: json.endpoint, keys: json.keys });
  return ok ? null : data?.error || "Couldn't save the subscription.";
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await postJson("/api/push", { endpoint: sub.endpoint }, "DELETE");
  await sub.unsubscribe().catch(() => {});
}
