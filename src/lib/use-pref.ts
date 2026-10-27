"use client";

import { useCallback } from "react";
import { useSession } from "@/components/providers/session-provider";
import { mutate } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import type { Me } from "@/lib/types";

type PrefValue = string | number | boolean;

/**
 * A per-person UI preference (layout, sort, range…) that follows them to
 * every device: stored on their account (users.prefs) and read from the
 * session that is already loaded, so there is no extra request. Setting one
 * paints immediately and saves in the background.
 */
export function usePref<T extends PrefValue>(key: string, fallback: T): [T, (value: T) => void] {
  const { me } = useSession();
  const raw = me?.prefs?.[key];
  const value = (typeof raw === typeof fallback ? raw : fallback) as T;
  const set = useCallback(
    (next: T) => {
      if (!me) return;
      const prefs = { ...(me.prefs ?? {}), [key]: next };
      mutate("/api/auth/me", { user: { ...me, prefs } as Me });
      void postJson("/api/auth/me", { prefs: { [key]: next } }, "PATCH").then((r) => {
        if (!r.ok) mutate("/api/auth/me"); // the paint was a guess; show what the server kept
      });
    },
    [me, key]
  );
  return [value, set];
}
