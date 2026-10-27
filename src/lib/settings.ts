import { getSupabase } from "./supabase";

/** Workspace settings (app_settings table), typed. */
interface ApprovalPolicy {
  /** done_only: only "done"/"cancelled" need an admin's approval (default).
   *  all: every member status change is reviewed. none: members apply directly. */
  mode: "done_only" | "all" | "none";
}
export interface Settings {
  approval_policy: ApprovalPolicy;
  workspace_name: string;
}

const DEFAULTS: Settings = {
  approval_policy: { mode: "done_only" },
  workspace_name: "Mobile team",
};

/** Instance-local cache: settings are read on nearly every task mutation and
 * change a few times a year. The mutating instance invalidates itself; others
 * pick a change up within SETTINGS_CACHE_MS. */
const SETTINGS_CACHE_MS = 30_000;
let cached: { at: number; value: Settings } | null = null;

export function invalidateSettingsCache() {
  cached = null;
}

/** `fresh` skips the instance cache: use it where the policy decides what
 * happens (status changes, release requests), so an admin's change applies
 * on the very next action on every instance. */
export async function getSettings(fresh = false): Promise<Settings> {
  if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
  const { data, error } = await getSupabase().from("app_settings").select("key, value").in("key", ["approval_policy", "workspace_name"]);
  // A failed read falls back to defaults WITHOUT caching, so the next call retries.
  if (error) return DEFAULTS;
  const map = new Map((data || []).map((r) => [r.key as string, r.value as unknown]));
  const ap = map.get("approval_policy") as Partial<ApprovalPolicy> | undefined;
  const wn = map.get("workspace_name");
  const value: Settings = {
    approval_policy: {
      mode: ap?.mode === "all" || ap?.mode === "none" ? ap.mode : "done_only",
    },
    workspace_name: typeof wn === "string" && wn.trim() ? wn.trim().slice(0, 60) : DEFAULTS.workspace_name,
  };
  cached = { at: Date.now(), value };
  return value;
}

/** Does a member's move to `to` need an admin's approval under the policy? */
export function needsApproval(policy: ApprovalPolicy, to: string): boolean {
  if (policy.mode === "none") return false;
  if (policy.mode === "all") return true;
  return to === "done" || to === "cancelled";
}
