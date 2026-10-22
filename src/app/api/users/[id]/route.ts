import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getAuthenticatedUser, invalidateAuthCache } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { hashPassword } from "@/lib/password";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanName, displayName } from "@/lib/name";
import { cleanLine, isHexColor, isUuid, oneOf } from "@/lib/validate";
import { DEPARTMENTS, LIMITS } from "@/lib/domain";

export const dynamic = "force-dynamic";

async function adminCount(sb: ReturnType<typeof getSupabase>): Promise<number> {
  const { count } = await sb.from("users").select("id", { count: "exact", head: true }).eq("role", "admin").eq("is_active", true);
  return count ?? 0;
}

/** Admin edits a teammate: role, department, title, name, colour, active flag,
 * or a password reset (which revokes their sessions and forces a new password). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return fail("User not found", 404);
  const me = await getAuthenticatedUser();
  const b = await readJsonObject(req);
  const sb = getSupabase();

  const { data: target } = await sb.from("users").select("role, token_version, is_active, first_name, last_name, email, department, title").eq("id", id).maybeSingle();
  if (!target) return fail("User not found", 404);

  const update: Record<string, unknown> = {};
  const changes: string[] = [];

  if (b.role === "admin" || b.role === "member") {
    if (b.role !== target.role && id === me?.uid) return fail("You can't change your own role");
    if (b.role !== target.role) {
      // Never let the last active admin demote themselves/anyone out of admin.
      if (target.role === "admin" && b.role === "member" && target.is_active && (await adminCount(sb)) <= 1) {
        return fail("At least one active admin is required");
      }
      update.role = b.role;
      changes.push(`role → ${b.role}`);
    }
  }
  if (typeof b.is_active === "boolean" && b.is_active !== target.is_active) {
    if (id === me?.uid) return fail("You can't deactivate your own account");
    if (!b.is_active && target.role === "admin" && (await adminCount(sb)) <= 1) return fail("At least one active admin is required");
    update.is_active = b.is_active;
    // Deactivation kills every session immediately (token_version bump below)
    // and every push device: a lost phone must not keep receiving task titles.
    if (!b.is_active) await sb.from("push_subscriptions").delete().eq("user_id", id);
    changes.push(b.is_active ? "re-activated" : "deactivated");
  }
  if (typeof b.password === "string" && b.password.length > 0) {
    if (b.password.length < 8) return fail("Password must be at least 8 characters");
    if (b.password.length > 200) return fail("Password is too long");
    update.password_hash = await hashPassword(b.password);
    update.must_change_password = true;
    await Promise.all([sb.from("push_subscriptions").delete().eq("user_id", id), sb.from("auth_throttle").delete().eq("key", `email:${String(target.email).toLowerCase()}`)]);
    changes.push("password reset");
  }
  if ("first_name" in b || "last_name" in b) {
    const first = cleanName(b.first_name ?? target.first_name);
    const last = cleanName(b.last_name ?? target.last_name);
    if (!first) return fail("First name can't be empty");
    update.first_name = first;
    update.last_name = last || null;
    if (first !== target.first_name || (last || null) !== (target.last_name ?? null)) changes.push(`name → ${displayName(first, last)}`);
  }
  if ("department" in b) {
    const d = oneOf(b.department, DEPARTMENTS);
    if (!d) return fail("Pick a valid department");
    update.department = d;
    if (d !== (target as { department?: string }).department) changes.push(`department → ${d}`);
  }
  if ("title" in b) {
    update.title = cleanLine(b.title, LIMITS.userTitle) || null;
    if (update.title !== ((target as { title?: string | null }).title ?? null)) changes.push("title");
  }
  if ("color" in b) {
    if (!isHexColor(b.color)) return fail("Pick a valid colour");
    update.color = String(b.color).toLowerCase();
    changes.push("colour");
  }
  if (Object.keys(update).length === 0) return fail("Nothing to update");

  // Anything that must end existing sessions bumps token_version.
  if (update.password_hash || update.is_active === false || update.role) {
    update.token_version = Number(target.token_version ?? 0) + 1;
  }

  const { error } = await sb.from("users").update(update).eq("id", id);
  if (error) return serverError(error);
  // Check-then-act closed: re-verify the admin floor after the write.
  if ((update.role === "member" || update.is_active === false) && target.role === "admin" && (await adminCount(sb)) === 0) {
    await sb.from("users").update({ role: "admin", is_active: true }).eq("id", id);
    invalidateAuthCache(id);
    return fail("At least one active admin is required");
  }
  invalidateAuthCache(id);
  await logActivity({ action: "user.update", entityType: "user", entityId: id, summary: `Updated ${displayName(target.first_name, target.last_name) || target.email} (${changes.join(", ")})` });
  return ok();
}

/** Remove a teammate entirely (admin only). History keeps their name via the
 * denormalised activity email; task rows keep working (FKs set null). Prefer
 * deactivation — it keeps the person visible on old tasks. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return fail("User not found", 404);
  const me = await getAuthenticatedUser();
  if (me?.uid === id) return fail("You can't remove your own account");

  const sb = getSupabase();
  const { data: target } = await sb.from("users").select("*").eq("id", id).maybeSingle();
  if (!target) return fail("User not found", 404);
  if (target.role === "admin" && target.is_active && (await adminCount(sb)) <= 1) return fail("At least one active admin is required");

  const { error } = await sb.from("users").delete().eq("id", id);
  if (error) return serverError(error);
  if (target.role === "admin" && (await adminCount(sb)) === 0) {
    await sb.from("users").insert(target);
    invalidateAuthCache(id);
    return fail("At least one active admin is required");
  }
  invalidateAuthCache(id);
  await logActivity({ action: "user.remove", entityType: "user", entityId: id, summary: `Removed ${displayName(target.first_name, target.last_name) || target.email}` });
  return ok();
}
