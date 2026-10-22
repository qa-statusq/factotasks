"use client";

import { disablePush } from "@/lib/push-client";

import { clearAllCache } from "./client-cache";
import { timeoutSignal, tabMemClear } from "./compat";

/**
 * THE one sign-out path. Every "Sign out" control in the panel goes through
 * this, so the behaviour can never drift between the shell, the set-password
 * screen and the session-died teardown.
 *
 * Why it isn't just `fetch(logout).then(goto login)`:
 *
 *  1. The session cookie is httpOnly — only the SERVER can clear it — and the
 *     the proxy bounces authed users off /login. So leaving with the cookie
 *     still set silently returns the user to the dashboard: the round trip is
 *     mandatory, it can't be made optimistic.
 *  2. A fetch/XHR is the one thing on the page that a content blocker, a
 *     corporate proxy/MDM profile or a flaky socket can kill on ONE machine
 *     while every normal page load keeps working — which is exactly how a
 *     signed-in user ends up unable to leave. So when the POST fails for any
 *     reason we do NOT dead-end on an error toast: we hand the job to a
 *     top-level GET navigation to the same route, which clears the cookie
 *     during the navigation and redirects to /login. A document navigation is
 *     the most compatible request a browser can make — it survives blocked
 *     XHR, missing AbortController, and every engine back to IE.
 *  3. Only a genuinely offline browser is left with nothing to try; that (and
 *     only that) is worth telling the user about.
 *
 * Returns `false` ONLY when nothing could be attempted (offline). Otherwise it
 * navigates and the returned promise never settles — the document is going
 * away, so callers must keep their pending UI on screen.
 */
const SIGNOUT_PATH = "/api/auth/logout";

/** Drop every byte of the previous account from this tab BEFORE the document
 * is torn down (in-memory caches, the persisted snapshot, scroll/dialog
 * memory). Synchronous and total — see tabMemClear. */
function wipeClientState() {
  clearAllCache();
  tabMemClear();
}

export async function signOut(): Promise<boolean> {
  // This browser's push subscription belongs to the person signing out: drop
  // it (best effort, bounded) so the next person here never gets their alerts.
  try {
    await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 2500))]);
  } catch {
    /* best effort */
  }
  let ok = false;
  try {
    const r = await fetch(SIGNOUT_PATH, {
      method: "POST",
      // Old engines defaulted fetch credentials to "omit" — spelled out so the
      // session cookie is always attached and the server clears the RIGHT one.
      credentials: "same-origin",
      cache: "no-store",
      // Generous but bounded: the route no longer touches the database on the
      // response path, so anything past this is a dead socket, not slowness.
      signal: timeoutSignal(8_000),
    });
    ok = r.ok;
  } catch {
    ok = false;
  }

  if (ok) {
    wipeClientState();
    // HARD document navigation with replace — never router.push: an SPA nav
    // keeps Next's client router cache alive, and Back from the login screen
    // replayed every visited authed screen from that cache. Replacing the
    // document tears all of it down.
    window.location.replace("/login");
    return new Promise<boolean>(() => {}); // never resolves — we're leaving
  }

  // Offline is the one state where the fallback navigation can't help either:
  // it would land the user on the browser's own error page while still signed
  // in. `onLine === false` is trustworthy (a false NEGATIVE is impossible);
  // `true` only means "there is a network interface", which is why it's never
  // used to decide the happy path.
  // NOTE the wipe is deliberately NOT hoisted above this branch: the user is
  // staying on a live, still-signed-in tab, and clearing the caches there
  // would blank every screen behind the error message for no reason. State is
  // only ever discarded on a path that is definitely leaving the document.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;

  wipeClientState();
  window.location.replace(SIGNOUT_PATH);
  return new Promise<boolean>(() => {});
}
