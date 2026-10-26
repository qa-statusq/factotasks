"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { timeoutSignal } from "@/lib/compat";
import { useLatest } from "./use-latest";

/**
 * Minimal stale-while-revalidate cache for GET endpoints.
 *
 * Goals (no external dependency):
 *  - Return cached data INSTANTLY on revisit (no spinner on back-navigation).
 *  - De-dupe concurrent requests for the same URL across components, so e.g.
 *    the sidebar and the dashboard share ONE `/api/stats` call.
 *  - Let writes invalidate keys via `mutate()` so the UI refreshes in place.
 *
 * It is intentionally tiny — it caches by URL string and revalidates on mount.
 */

interface Entry {
  data: unknown;
  ts: number;
  /** When an optimistic edit last painted this entry (it keeps `ts`, so it still revalidates). */
  optAt?: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<() => void>>();

/**
 * sessionStorage persistence of a few HOT keys, so a reload / restored tab
 * paints complete data at first render and revalidates silently — instead of
 * skeletons while the whole boot chain refetches (the single biggest
 * perceived-speed win on slow connections). WHITELISTED keys only: small,
 * screen-critical payloads — never accumulated lists or the analytics/daily
 * blob (quota + serialization cost). Per-tab by design (sessionStorage), and
 * cleared by clearAllCache() on logout; login also clears before navigating,
 * so a same-tab account switch can never paint the previous user's data.
 * Hydrated entries keep their ORIGINAL ts, so the existing mount-time
 * freshness check revalidates anything stale in the background — the normal
 * stale-while-revalidate contract, just warm-started.
 */
const PERSIST_STORAGE_KEY = "factotasks:cache:v1";
const PERSIST_KEYS = new Set([
  "/api/auth/me",
  "/api/dashboard",
  "/api/apps",
  "/api/users",
  "/api/notifications?limit=1",
  "/api/tasks?scope=open",
]);
let persistTimer = 0;
function schedulePersist() {
  if (typeof window === "undefined" || persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    try {
      const snap: Record<string, Entry> = {};
      for (const k of PERSIST_KEYS) {
        const e = cache.get(k);
        if (e) snap[k] = e;
      }
      sessionStorage.setItem(PERSIST_STORAGE_KEY, JSON.stringify(snap));
    } catch {
      /* quota/blocked — persistence is best-effort */
    }
  }, 500);
}
if (typeof window !== "undefined") {
  try {
    const snap = JSON.parse(sessionStorage.getItem(PERSIST_STORAGE_KEY) || "null") as Record<string, Entry> | null;
    if (snap && typeof snap === "object") {
      for (const [k, e] of Object.entries(snap)) {
        if (PERSIST_KEYS.has(k) && e && typeof e.ts === "number" && e.data !== undefined) cache.set(k, e);
      }
    }
  } catch {
    /* corrupted snapshot — start cold */
  }
}

/** A freshly-fetched value is considered fresh for this long, so revisiting a
 * screen within the window skips even the background revalidation. */
const DEDUPE_MS = 10_000;

/**
 * Standard SaaS freshness: when the user returns to the tab (focus/visible) or
 * the connection comes back, silently revalidate everything currently on screen
 * — so counts and lists are up to date after time away in Play Console etc.,
 * without a manual refresh. Throttled by data age so rapid alt-tabbing is free.
 */
const FOCUS_REVALIDATE_MS = 15_000;
if (typeof window !== "undefined") {
  const revalidateVisible = () => {
    for (const key of subscribers.keys()) {
      const e = cache.get(key);
      if (!e || Date.now() - e.ts > FOCUS_REVALIDATE_MS) revalidate(key).catch(reportAuthFailure);
    }
  };
  window.addEventListener("focus", revalidateVisible);
  window.addEventListener("online", revalidateVisible);
  // Long-background wake-up: browsers freeze background tabs, and with
  // scale-to-zero hosting the SERVER has gone cold too — so the first click
  // after returning used to pay the whole cold start. Refocusing after a long
  // stay away now immediately warms the server AND prefetches the hot screens
  // (the same whitelisted keys the reload snapshot keeps), so by the time the
  // user clicks, the data is already on its way or already here. Short
  // alt-tabs skip it — revalidateVisible alone covers those.
  const LONG_HIDDEN_MS = 5 * 60_000;
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    revalidateVisible();
    if (hiddenAt && Date.now() - hiddenAt > LONG_HIDDEN_MS) {
      // NOT prefetch(): that no-ops whenever the key is already cached, and
      // after a long background these keys are exactly cached-but-STALE — so
      // the warm-up would silently do nothing. Refetch anything old enough,
      // subscribed or not; inflight dedupe absorbs the overlap with the
      // revalidateVisible() call above.
      for (const key of PERSIST_KEYS) {
        const e = cache.get(key);
        if (!e || Date.now() - e.ts > FOCUS_REVALIDATE_MS) revalidate(key).catch(() => {});
      }
    }
  });
  // pageshow covers the back/forward-cache resume path, where
  // visibilitychange may not refire.
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) revalidateVisible();
  });
}

/**
 * OPTIMISTIC, in-place edit of every cached payload whose key starts with
 * `prefix`: `fn` receives the cached value and returns the new one (or
 * undefined to leave it). Subscribers repaint synchronously — this is what
 * makes a status change feel instant — and the caller then kicks a normal
 * background revalidation so the server's truth lands a moment later.
 */
export function mutateWhere(prefix: string, fn: (data: unknown, key: string) => unknown) {
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue;
    const next = fn(entry.data, key);
    if (next === undefined || next === entry.data) continue;
    // Keep the entry's own timestamp: an optimistic edit is a guess, not a
    // fresh fetch, so the next mount / poll still asks the server.
    cache.set(key, { data: next, ts: entry.ts, optAt: Date.now() });
    notify(key);
    if (PERSIST_KEYS.has(key)) schedulePersist();
  }
}

/** Background-revalidate every mounted key under `prefix` (after an optimistic edit). */
export function revalidatePrefix(prefix: string) {
  for (const key of subscribers.keys()) if (key.startsWith(prefix)) revalidate(key, true).catch(reportAuthFailure);
}

/**
 * Re-fetch EVERY key something is currently subscribed to — the change poll
 * (lib/use-live-updates) calls this when the server-side change counter moves,
 * so screens update within a poll interval without any per-screen wiring.
 * Fresh entries (younger than DEDUPE_MS) are skipped: they already reflect
 * the change that bumped the counter.
 */
export function revalidateAllMounted(since = Date.now() - DEDUPE_MS) {
  for (const key of subscribers.keys()) {
    const e = cache.get(key);
    // Anything fetched before the counter was last reconciled may predate the change.
    if (!e || e.ts <= since) revalidate(key).catch(reportAuthFailure);
  }
}

/**
 * Session-death broadcast. Background revalidations (focus/online/mutate)
 * swallow errors BY DESIGN — a transient failure must keep the stale data on
 * screen. But a 401 is not transient: the session is gone, and every painted
 * byte belongs to it. Without this, a tab left open through a logout (or a
 * password change) in another tab kept showing the dead session's data on
 * every focus until the user happened to navigate. SessionProvider registers
 * the one handler that tears the tab down; fired at most once per epoch so a
 * burst of failing revalidations can't stack teardowns.
 */
let authFailHandler: (() => void) | null = null;
let authFailFiredEpoch = -1;
export function onAuthFailure(handler: (() => void) | null) {
  authFailHandler = handler;
}
function reportAuthFailure(e: unknown) {
  if ((e as { status?: number } | null)?.status !== 401) return;
  if (authFailFiredEpoch === epoch) return;
  authFailFiredEpoch = epoch;
  authFailHandler?.();
}

function notify(key: string) {
  const subs = subscribers.get(key);
  if (subs) subs.forEach((fn) => fn());
}

/**
 * Invalidate or set a cache key.
 *  - `mutate(key, data)` writes a value directly (optimistic updates).
 *  - `mutate(key)` invalidates: if the key is currently shown, it revalidates in
 *    the background while KEEPING the stale value (so the UI never flashes an
 *    empty/loading state); if nothing is mounted, it drops the value so the next
 *    mount refetches.
 */
export function mutate(key: string, data?: unknown) {
  if (data !== undefined) {
    cache.set(key, { data, ts: Date.now() });
    notify(key);
    if (PERSIST_KEYS.has(key)) schedulePersist();
    return;
  }
  if (subscribers.get(key)?.size) {
    // revalidate() updates the cache and notifies subscribers when it resolves.
    // force: a fetch already in flight predates this write — its payload must
    // not be committed as the post-write state.
    revalidate(key, true).catch(reportAuthFailure);
  } else {
    cache.delete(key);
    notify(key);
    if (PERSIST_KEYS.has(key)) schedulePersist();
  }
}

/**
 * Invalidate EVERY cached/subscribed key that starts with `prefix` — needed for
 * endpoints whose URL carries query params (e.g. `/api/dashboard/recent-replies`
 * is keyed as `?source=all|auto|manual|external`), where an exact `mutate()`
 * would miss the live key and the screen would never refresh after a sync.
 */
export function mutatePrefix(prefix: string) {
  const keys = new Set<string>();
  for (const k of cache.keys()) if (k.startsWith(prefix)) keys.add(k);
  for (const k of subscribers.keys()) if (k.startsWith(prefix)) keys.add(k);
  keys.forEach((k) => mutate(k));
}

/** Wipe everything — call on logout so the next account never sees the previous
 * user's cached responses (stats, apps, etc.). Bumping the epoch also discards
 * every IN-FLIGHT revalidation: without it, a fetch started before logout would
 * resolve afterwards and repopulate the cache with the previous account's data
 * (served fresh to the next signed-in user). */
let epoch = 0;
export function clearAllCache() {
  epoch++;
  cache.clear();
  inflight.clear();
  // A latched force-rerun belongs to the previous session — carrying it over
  // would make the next login's first fetch of that key discard its own valid
  // payload and refetch for nothing.
  rerunAfter.clear();
  // The persisted snapshot belongs to the previous session too — remove it
  // IMMEDIATELY (not debounced), and kill any pending write that could
  // resurrect it after this clear.
  if (typeof window !== "undefined") {
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
    try {
      sessionStorage.removeItem(PERSIST_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Is this failure worth one more try, or is it the answer?
 *
 * TRANSIENT — no response at all (dropped socket, DNS blip, our own 15s
 * timeout), or the server explicitly saying "not now": 408, 425, 429, and every
 * 5xx. That includes the 503 the auth guard returns for a database wobble,
 * which is precisely the case that must never reach the user as a broken screen.
 *
 * FINAL — anything else. 401 above all: the session-death path has to fire
 * promptly, so retrying it would only delay the sign-out. 403/404/400 will
 * answer identically forever.
 */
function isTransient(e: unknown): boolean {
  const status = e instanceof HttpError ? e.status : 0;
  if (status === 0) return true; // fetch threw — the request never got an answer
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// One retry, then report. A second in-line retry down the same failing path
// almost never succeeds and only makes the screen sit longer on a skeleton —
// focus/online revalidation is the real safety net beyond this.
const READ_RETRY_PAUSE_MS = 600;

async function fetchOnce(url: string): Promise<unknown> {
  // Timeout so a request the network silently drops can never leave its
  // `inflight` slot occupied forever (which would pin every consumer of that
  // key on a loader until a full page reload). On timeout it rejects, the
  // slot clears, and the next mount/focus revalidation retries cleanly.
  const r = await fetch(url, { signal: timeoutSignal(15_000) });
  if (!r.ok) throw new HttpError(r.status);
  return r.json();
}

/**
 * A read, with ONE automatic retry for a transient failure.
 *
 * Every screen in the panel loads through here, and before this a single
 * dropped request was terminal for that key: the hook flipped to `error` with
 * no data, so a screen either showed a failure or — for the many consumers that
 * only branch on `loading` — rendered its EMPTY state, which claims "there is
 * nothing here" when the truth is "we could not ask". Nothing recovered it until
 * the user refocused the tab or navigated away and back.
 *
 * This is the read-side twin of the fleet-sync retry: the overwhelming majority
 * of these failures are a blip, and the right response to a blip is to ask
 * again rather than to make the user do it.
 */
async function fetchJson(url: string): Promise<unknown> {
  try {
    return await fetchOnce(url);
  } catch (e) {
    if (!isTransient(e)) throw e;
    await new Promise((r) => setTimeout(r, READ_RETRY_PAUSE_MS));
    return fetchOnce(url);
  }
}

// Keys whose in-flight fetch was invalidated MID-FLIGHT by a write: the
// response in the air carries PRE-write data. Without this, mutate(key) during
// a background revalidation was a silent no-op — revalidate() returned the old
// promise, no fresh request was ever made, and the stale payload committed
// (the needs-attention badge/stats stayed wrong until the next focus
// revalidation). The finished fetch skips its commit and chains a fresh one.
const rerunAfter = new Set<string>();

function revalidate(key: string, force = false): Promise<unknown> {
  let p = inflight.get(key);
  if (p) {
    if (force) rerunAfter.add(key);
    return p;
  }
  const startedEpoch = epoch;
  const startedAt = Date.now();
  p = fetchJson(key)
    .then((d) => {
      inflight.delete(key);
      // Logout happened while this was in flight — the response belongs to the
      // previous session and must never repopulate the cleared cache.
      if (startedEpoch !== epoch) return d;
      // A write invalidated this key after the fetch left — the payload is
      // pre-write. Don't commit it; fetch again for the post-write truth.
      if (rerunAfter.delete(key)) {
        revalidate(key).catch(() => {});
        return d;
      }
      const prev = cache.get(key);
      // An optimistic mutate(key, data) landed AFTER this fetch started — the
      // fetch carries pre-write data; committing it would visibly revert the
      // user's action until the next refresh. The optimistic value wins.
      if (prev !== undefined && (prev.ts > startedAt || (prev.optAt ?? 0) > startedAt)) return d;
      // Skip the notify when the payload is byte-identical to what's cached —
      // background revalidations that changed nothing shouldn't re-render every
      // subscriber (payloads here are small, so the stringify is cheap).
      // Unchanged entries are refreshed IN PLACE (same object) so the snapshot
      // identity useSyncExternalStore compares stays stable without a notify.
      const unchanged = prev !== undefined && JSON.stringify(prev.data) === JSON.stringify(d);
      if (unchanged) prev.ts = Date.now();
      else cache.set(key, { data: d, ts: Date.now() });
      if (!unchanged) notify(key);
      // Persist either way — the refreshed ts matters too (it's what lets the
      // next reload skip an immediate revalidation of still-fresh data).
      if (PERSIST_KEYS.has(key)) schedulePersist();
      return d;
    })
    .catch((e) => {
      inflight.delete(key);
      // The write's invalidation must survive this fetch failing — otherwise
      // stale pre-write data sits until the next focus revalidation. ONE
      // chained retry only (the chain carries no force, so it cannot loop).
      if (rerunAfter.delete(key) && startedEpoch === epoch) revalidate(key).catch(() => {});
      throw e;
    });
  inflight.set(key, p);
  return p;
}

/**
 * Warm the cache for a URL ahead of navigation (e.g. on nav-link hover) so the
 * destination screen paints with data immediately instead of a skeleton.
 * No-ops if already cached or in flight.
 */
export function prefetch(url: string) {
  if (!url || cache.has(url) || inflight.has(url)) return;
  revalidate(url).catch(() => {
    /* best-effort warm-up; the real consumer will surface any error */
  });
}

interface CachedFetch<T> {
  data: T | undefined;
  /** True only on the FIRST load (no cached value yet). Revisits never show it. */
  loading: boolean;
  error: Error | null;
  /** Force a background revalidation. */
  refresh: () => void;
}

export function useCachedFetch<T = unknown>(
  url: string | null,
  opts?: { enabled?: boolean; onError?: (e: Error) => void }
): CachedFetch<T> {
  const key = url ?? "";
  const enabled = (opts?.enabled ?? true) && !!url;

  // The error is stored WITH the key it belongs to, so switching to a new key
  // never inherits a stale error (which would wrongly cancel its loading state).
  const [errorFor, setErrorFor] = useState<{ key: string; error: Error } | null>(null);

  const onErrorRef = useLatest(opts?.onError);

  // Subscribe via useSyncExternalStore, NOT a useEffect + forceRender. The
  // effect version had a mount race: a fetch started earlier (hover prefetch,
  // a sibling, a previous page) could resolve in the gap between this
  // component's first render and its subscribe effect — notify() found no
  // subscriber, the mount revalidation then skipped (entry fresh), and the
  // component sat on a loader forever with the data already cached (fixed
  // only by navigating away and back). useSyncExternalStore re-reads the
  // snapshot right after subscribing and re-renders on any mismatch, which
  // closes that gap by design — rapid navigation can no longer strand a
  // screen on its skeleton.
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      let subs = subscribers.get(key);
      if (!subs) {
        subs = new Set();
        subscribers.set(key, subs);
      }
      subs.add(cb);
      return () => {
        subs!.delete(cb);
        if (subs!.size === 0) subscribers.delete(key);
      };
    },
    [key]
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : undefined),
    () => undefined // SSR: no cache on the server
  );

  const run = useCallback(
    (force = false) => {
      if (!enabled || !key) return;
      revalidate(key, force)
        .then(() => setErrorFor((cur) => (cur?.key === key ? null : cur)))
        .catch((e: Error) => {
          setErrorFor({ key, error: e });
          onErrorRef.current?.(e);
        });
    },
    [enabled, key, onErrorRef]
  );

  useEffect(() => {
    if (!enabled || !key) return;
    // Dedupe: if the cached value is still fresh, skip the background
    // revalidation on mount — this cuts redundant requests (and DB load) when
    // navigating quickly between screens. Writes still force a refresh via
    // mutate(), and refresh() ignores this window, so it never serves
    // stale-after-write data.
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < DEDUPE_MS) return;
    run();
  }, [enabled, key, run]);

  const refresh = useCallback(() => run(true), [run]);

  // `loading` is DERIVED from cache absence — never a lagging useState — so the
  // very same render that switches to an uncached key already reports
  // loading=true. The old effect-set state left one painted frame with
  // data=undefined + loading=false, which flashed empty states, collapsed the
  // page, and let the browser clamp the scroll to the top on filter switches.
  const error = errorFor?.key === key ? errorFor.error : null;
  return {
    data: entry?.data as T | undefined,
    loading: enabled && !entry && !error,
    error,
    // refresh is a USER action — it must supersede an in-flight background
    // revalidation, not be deduped into it.
    refresh,
  };
}
