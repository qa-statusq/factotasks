import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * A large attachment travels from the browser straight to the Shared Drive, so
 * the panel hands the uploader a signed ticket when it opens the session and
 * takes it back when the upload is done. The ticket pins who, which task,
 * what name and how many bytes — the finishing call can't attach a file to
 * another task, under another name, or for someone else. No table needed.
 */
export interface UploadTicket {
  /** Task id. */
  t: string;
  /** Uploader's user id. */
  u: string;
  /** Random id stamped on the Drive file (appProperties) — how the finished file is found. */
  n: string;
  /** Declared size in bytes. */
  s: number;
  /** Cleaned original file name. */
  f: string;
  /** Expiry (ms since epoch). */
  x: number;
}

const key = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return `upload:${s}`;
};
const sign = (body: string) => createHmac("sha256", key()).update(body).digest("base64url");

export function issueTicket(t: Omit<UploadTicket, "n" | "x">, ttlMs = 24 * 3600_000): { token: string; nonce: string } {
  const ticket: UploadTicket = { ...t, n: randomUUID(), x: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return { token: `${body}.${sign(body)}`, nonce: ticket.n };
}

export function readTicket(token: unknown): UploadTicket | null {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadTicket;
    return t.x > Date.now() ? t : null;
  } catch {
    return null;
  }
}
