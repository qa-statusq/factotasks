import { displayName } from "./name";
import { USER_COLORS } from "./domain";
import type { UserBrief } from "./types";

/** The columns every "who" embed selects — one string, so no route can
 * accidentally pull password_hash/token_version into a response. */
export const USER_BRIEF_COLS = "id, email, first_name, last_name, color, department, is_active";

/** Public person shape — NEVER the raw row. Mirrors the SQL user_brief(). */
export function brief(u: Record<string, unknown>): UserBrief {
  return {
    id: String(u.id),
    name: displayName(u.first_name as string | null, u.last_name as string | null) || String(u.email),
    first_name: (u.first_name as string | null) ?? null,
    last_name: (u.last_name as string | null) ?? null,
    email: String(u.email),
    color: (u.color as string) || USER_COLORS[0],
    department: (u.department as UserBrief["department"]) || "other",
    is_active: u.is_active !== false,
  };
}

/** A PostgREST to-one embed arrives as an object, or as a one-element array
 * when the relationship couldn't be proven unique. Normalise either to a
 * UserBrief (or null). */
export function embeddedUser(v: unknown): UserBrief | null {
  const row = Array.isArray(v) ? v[0] : v;
  return row && typeof row === "object" ? brief(row as Record<string, unknown>) : null;
}

/** Same normalisation for any to-one embed. */
export function embedded<T>(v: unknown): T | null {
  const row = Array.isArray(v) ? v[0] : v;
  return row && typeof row === "object" ? (row as T) : null;
}
