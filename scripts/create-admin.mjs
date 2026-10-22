// Create (or reset) the admin account directly — no APP_PASSWORD bootstrap needed.
// Usage:
//   node --env-file=.env.local scripts/create-admin.mjs <email> "<password>" [First] [Last]
//   npm run create-admin -- <email> "<password>"
// Falls back to ADMIN_EMAIL / ADMIN_PASSWORD env vars if args are omitted.
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

if (!globalThis.WebSocket) {
  const { default: ws } = await import("ws");
  globalThis.WebSocket = ws;
}

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";
const first = (process.argv[4] || "Admin").trim();
const last = (process.argv[5] || "").trim() || null;

if (!email || !password) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <email> "<password>" [First] [Last]');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (load with --env-file=.env.local).");
  process.exit(1);
}

// Matches lib/password.ts: scrypt$<base64 salt>$<base64 hash>
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

const sb = createClient(url, key, { auth: { persistSession: false } });

// Upsert on email: an existing row keeps its id/history and gets a fresh
// password + admin role; every one of its old sessions is revoked.
const { data: existing } = await sb.from("users").select("id, token_version").eq("email", email).maybeSingle();
const row = {
  email,
  password_hash: hashPassword(password),
  role: "admin",
  is_active: true,
  must_change_password: false,
  first_name: first,
  last_name: last,
  department: "management",
  token_version: existing ? Number(existing.token_version ?? 0) + 1 : 0,
};
// An existing account keeps its name and team unless names were given explicitly.
const { data: prior } = await sb.from("users").select("id").eq("email", email).maybeSingle();
if (prior && !process.argv[4]) {
  delete row.first_name;
  delete row.last_name;
  delete row.department;
}
await sb.from("auth_throttle").delete().eq("key", `email:${email}`); // a forgotten password often comes with a lockout
const { data, error } = await sb.from("users").upsert(row, { onConflict: "email" }).select("id, email, role").single();

if (error) {
  console.error("Failed to create admin:", error.message);
  process.exit(1);
}
console.log(`✓ Admin ready: ${data.email} (role: ${data.role}). You can sign in now.`);
