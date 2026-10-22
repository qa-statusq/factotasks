import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAuth } from "@/lib/guard";
import { getAuthenticatedUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { hashPassword } from "@/lib/password";
import { serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanName, displayName } from "@/lib/name";
import { cleanLine, oneOf, EMAIL_RE, isUniqueViolation } from "@/lib/validate";
import { DEPARTMENTS, LIMITS, USER_COLORS } from "@/lib/domain";
import { pickDistinctColor } from "@/lib/colors";
import { brief } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Team directory (every signed-in user): who can be assigned, who is who. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, email, first_name, last_name, color, department, is_active, role, title")
    .order("first_name", { ascending: true, nullsFirst: false })
    .order("email", { ascending: true });
  if (error) return serverError(error);
  const me = await getAuthenticatedUser();
  const users = (data || []).map((u) => ({ ...brief(u), role: u.role, title: u.title ?? null }));
  // Members get names and teams, never addresses.
  return NextResponse.json({ users: me?.role === "admin" ? users : users.map((u) => ({ ...u, email: "" })) });
}

/** Invite a teammate (admin only). They sign in with the temporary password
 * and must set their own before using the panel. */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const b = await readJsonObject(req);
  const mail = String(b.email || "").trim().toLowerCase();
  const pass = String(b.password || "");
  const role = b.role === "admin" ? "admin" : "member";
  const first = cleanName(b.first_name);
  const last = cleanName(b.last_name);
  const department = oneOf(b.department, DEPARTMENTS) ?? "other";
  const title = cleanLine(b.title, LIMITS.userTitle) || null;

  if (!first) return NextResponse.json({ error: "Enter the member's first name" }, { status: 400 });
  if (!EMAIL_RE.test(mail) || mail.length > 200) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  if (pass.length < 8) return NextResponse.json({ error: "Temporary password must be at least 8 characters" }, { status: 400 });
  if (pass.length > 200) return NextResponse.json({ error: "Password is too long" }, { status: 400 });

  const sb = getSupabase();
  // Avatar colour is automatic: the palette entry the team uses least.
  const { data: existingColors } = await sb.from("users").select("color");
  const color = pickDistinctColor((existingColors || []).map((r) => r.color as string), USER_COLORS);

  const { data, error } = await sb
    .from("users")
    .insert({
      email: mail,
      password_hash: await hashPassword(pass),
      role,
      first_name: first,
      last_name: last || null,
      department,
      title,
      color,
      must_change_password: true,
    })
    .select("id, email, first_name, last_name, color, department, is_active, role, title")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
    return serverError(error);
  }
  await logActivity({
    action: "user.invite",
    entityType: "user",
    entityId: String(data.id),
    summary: `Added ${displayName(first, last)} <${mail}> as ${role} (${department})`,
  });
  return NextResponse.json({ user: { ...brief(data), role: data.role, title: data.title ?? null } });
}
