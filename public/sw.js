/**
 * FactoTasks service worker — deliberately MINIMAL.
 *
 * Its ONLY job is the offline fallback: when a top-level NAVIGATION cannot
 * reach the network, serve the self-contained /offline.html instead of the
 * browser's default error page. Nothing else is intercepted or cached:
 *  - API calls, assets and every non-navigation request go straight to the
 *    network untouched (no respondWith), so online behaviour is byte-identical.
 *  - The cache holds exactly one static file with ZERO user data, so sign-out
 *    hygiene (lib/signout.ts) is unaffected.
 * Bump CACHE to invalidate after changing offline.html.
 */
const CACHE = "factotasks-offline-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: "reload" bypasses the HTTP cache so a stale copy can't stick.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // never touch API/asset requests
  event.respondWith(
    fetch(event.request)
      .then(async (res) => {
        // Infra-level failures (edge/Cloud Run 502/503/504, or a hard SSR 500)
        // would paint the platform's unbranded error page. Serve ours instead —
        // it self-detects "server unreachable vs offline" wording and retries
        // only after a probe of the real path succeeds, so it can never loop.
        // 4xx passes through untouched: the app's own branded 404/auth flows.
        if (res.status >= 500 && res.status <= 504) {
          const cached = await caches.match(OFFLINE_URL);
          if (cached) return cached;
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(OFFLINE_URL);
        // If install somehow never cached it, fall back to the browser default
        // rather than a broken empty response.
        return cached || Response.error();
      })
  );
});

/* ---------------- Browser push (Web Push) ----------------
   The server sends { title, body, url, tag }. A tap focuses an open panel tab
   (navigating it) or opens a new one. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FactoTasks", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "FactoTasks";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/brand/icon-192.png",
      badge: "/brand/icon-192.png",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || "/notifications" },
    })
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Prefer a tab that isn't presenting a deck; never steer one that is.
      const ours = list.filter((c) => new URL(c.url).origin === self.location.origin && !/\/meetings\/[^/]+\/present/.test(new URL(c.url).pathname));
      const c = ours[0];
      if (c) {
        return c
          .focus()
          .then(() => ("navigate" in c ? c.navigate(url) : null))
          .catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })
  );
});
