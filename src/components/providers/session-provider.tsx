"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { useCachedFetch, clearAllCache, onAuthFailure } from "@/lib/client-cache";
import { tabMemGet, tabMemSet, TAB_MEM_KEEP_PREFIX } from "@/lib/compat";
import { signOut } from "@/lib/signout";
import type { Me } from "@/lib/types";

/**
 * The one way a dead session leaves the tab. Clears every cache, clears the
 * cookie server-side, then HARD-replaces to /login (not router.replace: the
 * SPA that just 401'd still holds the dead session's screens in Next's client
 * router cache — Back must not be able to repaint them).
 *
 * Clearing the cookie first is LOAD-BEARING: a REVOKED token (password/role
 * changed elsewhere, account deactivated) still decodes fine in the proxy,
 * which bounces authed users off /login — landing there with the dead cookie
 * still set would ping-pong /login → / → 401 → /login forever.
 *
 * Loop guard: if the sign-out route itself keeps FAILING while pages still
 * load, a tab-memory stamp stops the cycle — within 30s of the previous pass,
 * stay put on the dead SPA instead of navigating again.
 */
const DIED_KEY = `${TAB_MEM_KEEP_PREFIX}session-died`;
function sessionDied() {
  clearAllCache();
  const now = Date.now();
  const recent = now - Number(tabMemGet(DIED_KEY) || 0) < 30_000;
  tabMemSet(DIED_KEY, String(now));
  if (recent) return;
  void signOut();
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  isAdmin: boolean;
  /** /api/auth/me failed (network, 5xx): who we are is unknown, not "a member". */
  error: boolean;
  refresh: () => void;
}

const SessionCtx = createContext<SessionValue>({ me: null, loading: true, isAdmin: false, error: false, refresh: () => {} });

/** Current signed-in user — fetched ONCE and shared, instead of every page
 * calling `/api/auth/me` on its own (and on every navigation). */
export function useSession() {
  return useContext(SessionCtx);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { data, loading, error, refresh } = useCachedFetch<{ user?: Me }>("/api/auth/me", {
    onError: (e) => {
      if ((e as { status?: number }).status === 401) sessionDied();
    },
  });
  // 401 from any BACKGROUND revalidation (focus/online/mutate — paths that
  // swallow errors by design): a tab left open through a logout, password
  // change or deactivation learns its session is dead on the next focus.
  useEffect(() => {
    onAuthFailure(sessionDied);
    return () => onAuthFailure(null);
  }, []);
  const me = data?.user ?? null;
  const value = useMemo<SessionValue>(() => ({ me, loading, isAdmin: me?.role === "admin", error: !me && !!error, refresh }), [me, loading, error, refresh]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
