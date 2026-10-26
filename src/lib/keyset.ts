/**
 * Keyset (cursor) pagination helpers. Unlike OFFSET, keyset walks the index by
 * the ordering key, so page depth costs the same on page 1 or page 10,000.
 * Cursors are opaque base64url tokens the client just echoes back.
 */
export function encodeCursor(obj: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/;

/** Decode + STRICTLY validate a cursor. Cursors round-trip through the browser,
 * so a tampered one must degrade to `null` (= first page) — not reach PostgREST
 * and 500. Known fields: i = row uuid; c = timestamp; n = integer. */
export function decodeCursor(s: string | null | undefined): { i?: string; c?: string; n?: number } | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out: { i?: string; c?: string; n?: number } = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "i") {
        if (typeof v !== "string" || !UUID_RE.test(v)) return null;
        out.i = v;
      } else if (k === "c") {
        if (typeof v !== "string" || !ISO_RE.test(v)) return null;
        out.c = v;
      } else if (k === "n") {
        if (typeof v !== "number" || !Number.isInteger(v)) return null;
        out.n = v;
      } else {
        return null; // unknown field — not one of ours
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Quote a value for use inside a PostgREST or()/and() filter string. Cursor
 * values are CLIENT-CONTROLLED, so quotes/backslashes are stripped — a crafted
 * cursor must never splice extra filter clauses into the query. */
const qv = (v: string | number) => `"${String(v).replace(/[\\"]/g, "")}"`;

/** Keyset predicate for ORDER BY (<col> desc, id desc) over a NOT-NULL timestamp column. */
export function tsIdKeysetDesc(col: string, c: { c: string; i: string }): string {
  return `${col}.lt.${qv(c.c)},and(${col}.eq.${qv(c.c)},id.lt.${qv(c.i)})`;
}
