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

/** iPhone/iPad Safari outside the Home Screen: push exists only once the panel is added there. */
export function needsHomeScreen(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
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
/** "<endpoint>|<ms>": this device was confirmed registered to this account at that time. */
const OK_KEY = (uid: string) => `ft_push_ok:${uid}`;
const RECHECK_MS = 24 * 3600_000;
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

async function subscribeAndRegister(reg: ServiceWorkerRegistration, uid?: string): Promise<string | null> {
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
  if (ok && uid) lsSet(OK_KEY(uid), `${sub.endpoint}|${Date.now()}`);
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
  const err = await subscribeAndRegister(reg, uid);
  if (!err && uid) lsSet(OFF_KEY(uid), null);
  return err;
}

export async function disablePush(uid?: string): Promise<void> {
  if (uid) {
    lsSet(OFF_KEY(uid), "1");
    lsSet(OK_KEY(uid), null);
  }
  const sub = await currentSubscription();
  if (!sub) return;
  await postJson("/api/push", { endpoint: sub.endpoint }, "DELETE");
  await sub.unsubscribe().catch(() => {});
}

const syncing = new Map<string, Promise<void>>();
/**
 * Make sure this device is registered to this account wherever notifications
 * are already allowed — no prompt, no click. Runs once per account per page
 * load and is SHARED: every caller (the shell, the Profile card) awaits the same
 * run, so nobody reads the device state while a registration is half done.
 */
export function syncPush(uid: string): Promise<void> {
  let run = syncing.get(uid);
  if (!run) {
    run = doSync(uid);
    syncing.set(uid, run);
  }
  return run;
}

async function doSync(uid: string): Promise<void> {
  if (!pushSupported() || !pushConfigured()) return;
  if (Notification.permission !== "granted" || pushOptedOut(uid)) return;
  try {
    const reg = await readyWorker();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Confirmed for this account in the last day, on this very subscription: nothing to ask the server.
      const [endpoint, at] = (lsGet(OK_KEY(uid)) ?? "").split("|");
      if (endpoint === sub.endpoint && Date.now() - Number(at) < RECHECK_MS) return;
      const r = await fetch(`/api/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { credentials: "same-origin" });
      const data = r.ok ? ((await r.json()) as { subscribed?: boolean }) : null;
      if (data?.subscribed) {
        lsSet(OK_KEY(uid), `${sub.endpoint}|${Date.now()}`);
        return;
      }
    }
    await subscribeAndRegister(reg, uid);
  } catch {
    /* best-effort: the Profile screen shows the state and a manual switch */
  }
}


/** Close this device's system notifications — those about one task (`tag`), or all of them. */
export async function closeSystemNotifications(tag?: string): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await readyWorker(2000);
    const list = reg ? await reg.getNotifications(tag ? { tag } : undefined) : [];
    for (const n of list) n.close();
  } catch {
    /* nothing to close */
  }
}
