"use client";

import { useMemo } from "react";
import { useCachedFetch } from "@/lib/client-cache";
import { nameLabels } from "@/lib/meeting-agenda";
import type { UserBrief } from "@/lib/types";

type Person = Pick<UserBrief, "id" | "name"> & { first_name?: string | null; last_name?: string | null };

/**
 * Short names that stay unambiguous everywhere: first names, plus a last
 * initial wherever two people share one ("Neel P." / "Neel S.") — the same
 * rule the meeting deck uses, computed over the whole team so a person added
 * later is covered the moment they exist.
 */
export function useNameLabels(): (u: Person) => string {
  const { data } = useCachedFetch<{ users: UserBrief[] }>("/api/users");
  const map = useMemo(() => nameLabels(data?.users ?? []), [data]);
  return (u) => map.get(u.id) ?? (u.first_name || u.name.split(" ")[0] || u.name);
}

/** The same labels for a list: "Kavy, Neel P." */
export function useNameList(): (users: Person[]) => string {
  const label = useNameLabels();
  return (users) => users.map(label).join(", ");
}
