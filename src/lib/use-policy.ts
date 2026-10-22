"use client";

import { useCachedFetch } from "@/lib/client-cache";
import { useSession } from "@/components/providers/session-provider";
import type { Settings } from "@/lib/settings";

/** Does a member's move to Done/Cancelled wait for an admin? Cached once
 * for the whole tab; admins never need approval. */
export function useNeedsApproval(): boolean {
  return usePolicyMode() !== "none";
}

/** The policy as the server applies it to THIS user: "none" for admins. */
export function usePolicyMode(): Settings["approval_policy"]["mode"] {
  const { isAdmin } = useSession();
  const { data } = useCachedFetch<{ settings: Settings }>("/api/settings");
  if (isAdmin) return "none";
  return data?.settings?.approval_policy?.mode ?? "done_only";
}

/** Will moving to `to` be parked as a request for this user? Mirrors lib/settings needsApproval(). */
export function willRequestStatus(mode: Settings["approval_policy"]["mode"], to: string): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  return to === "done" || to === "cancelled";
}
