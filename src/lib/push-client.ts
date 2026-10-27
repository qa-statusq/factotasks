"use client";

import { postJson } from "@/lib/http";

/**
 * Browser-side half of push: permission, subscription, and the server sync.
 *
 * A device receives pushes only when its subscription is registered to the
 * signed-in account. Browser permission alone is not enough, so every signed-in
 * load runs `syncPush()`: where notifications are already allowed it registers
 * (or re-registers) this device silently. Turning notifications off on the
 * Profile screen leaves a per-device, per-account opt-out the sync respects.
 */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
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

/* ---- per-device, per-account choices (localStorage can throw: always guarded) ---- */
const OFF_KEY = (uid: string) => `ft_push_off:${uid}`;
const PROMPT_KEY = (uid: string) => `ft_push_prompt:${uid}`;
function lsGet(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string | null): void {
  try {
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch {
    /* blocked storage: the choice simply isn't remembered */
  }
}

/** The person turned notifications off on this device: the silent sync leaves it alone. */
export function pushOptedOut(uid: string): boolean {
  return lsGet(OFF_KEY(uid)) === "1";
}

/** "Not now" on the prompt hides it for two weeks on this device. */
export function pushPromptSnoozed(uid: string): boolean {
  const t = Number(lsGet(PROMPT_KEY(uid)) || 0);
  return Number.isFinite(t) && Date.now() < t;
}
export function snoozePushPrompt(uid: string): void {
  lsSet(PROMPT_KEY(uid), String(Date.now() + 14 * 86_400_000));
}

async function subscribeAndRegister(reg: ServiceWorkerRegistration): Promise<string | null> {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "Notifications aren't configured on the server yet.";
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

/** Ask permission, subscribe this browser, and register it with the server.
 * Resolves with a message to show, or null on success. */
export async function enablePush(uid?: string): Promise<string | null> {
  if (!pushSupported()) return "This browser doesn't support notifications.";
  if (!pushConfigured()) return "Notifications aren't configured on the server yet.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications were blocked — allow them in the browser's site settings.";
  const reg = await readyWorker();
  if (!reg) return "The browser's background worker isn't available here (private window?).";
  const err = await subscribeAndRegister(reg);
  if (!err && uid) lsSet(OFF_KEY(uid), null);
  return err;
}

export async function disablePush(uid?: string): Promise<void> {
  if (uid) lsSet(OFF_KEY(uid), "1");
  const sub = await currentSubscription();
  if (!sub) return;
  await postJson("/api/push", { endpoint: sub.endpoint }, "DELETE");
  await sub.unsubscribe().catch(() => {});
}

const synced = new Set<string>();
/**
 * Make sure this device is registered to this account wherever notifications
 * are already allowed — no prompt, no click. Runs once per account per page
 * load; a no-op when the browser can't, the person said no here, or nothing
 * is allowed yet.
 */
export async function syncPush(uid: string): Promise<void> {
  if (synced.has(uid) || !pushSupported() || !pushConfigured()) return;
  synced.add(uid);
  if (Notification.permission !== "granted" || pushOptedOut(uid)) return;
  try {
    const reg = await readyWorker();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const r = await fetch(`/api/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { credentials: "same-origin" });
      const data = r.ok ? ((await r.json()) as { subscribed?: boolean }) : null;
      if (data?.subscribed) return;
    }
    await subscribeAndRegister(reg);
  } catch {
    /* best-effort: the Profile screen shows the state and a manual switch */
  }
}
