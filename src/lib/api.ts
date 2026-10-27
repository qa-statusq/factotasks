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
  const buf = await readCappedBody(req, MAX_JSON_BYTES);
  if (!buf) return {};
  let v: unknown = null;
  try {
    v = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    v = null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** No JSON request of the panel comes near this; anything bigger is refused unread. */
const MAX_JSON_BYTES = 1024 * 1024;

/**
 * The request body, read only up to `max` bytes: null when it is larger (or
 * unreadable). A declared Content-Length over the cap is refused before a byte
 * is read, and a body without one (chunked) is cut off at the cap — so no
 * request can make the server buffer more than `max`.
 */
export async function readCappedBody(req: Request, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(req.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

