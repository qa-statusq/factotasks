import { NextResponse } from "next/server";

/** Standard JSON success response. */
/** Members never receive teammates' e-mail addresses: every `email` field in
 * a payload (user briefs on cards, assignees, creators, requesters) is
 * blanked before the JSON leaves. Admins get the full payload. */
export function stripEmails<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripEmails) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = k === "email" && typeof v === "string" ? "" : stripEmails(v);
    return out as T;
  }
  return value;
}
export function memberJson(u: { role: string }, data: unknown, init?: ResponseInit) {
  return NextResponse.json(u.role === "admin" ? data : stripEmails(data), init);
}

export function ok(data: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...data });
}

/** Standard JSON error with a safe, client-facing message. */
export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Postgres/PostgREST codes meaning "that column or relationship isn't there
 * yet" — i.e. a migration hasn't been applied. Routes that read optional
 * columns fall back to a narrower shape on ANY error (graceful degradation),
 * but must NOT log these: pre-migration is an expected, whole-environment
 * state, so logging it would emit one line per request and drown real signal.
 */
export const EXPECTED_EMBED_MISS = new Set(["42703", "PGRST200", "PGRST204"]);

/**
 * For unexpected/internal errors: log the full detail server-side, return a
 * generic message so we never leak DB schema, stack traces, or secrets.
 */
export function serverError(e: unknown, fallback = "Something went wrong. Please try again.") {
  console.error("[api] internal error:", e);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/**
 * Parse a request body as a JSON OBJECT, never anything else. `req.json()`
 * happily returns null, a number or an array for a valid JSON body, and every
 * route then did `"x" in b` or destructured it — a 500 from a one-byte body
 * ("null"). Malformed JSON and non-objects both come back as `{}`, so the
 * route's own "x is required" validation answers instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonObject(req: Request): Promise<Record<string, any>> {
  const v = await req.json().catch(() => null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

