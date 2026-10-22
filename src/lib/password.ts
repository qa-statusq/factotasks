import crypto from "crypto";

/**
 * Password hashing with Node's built-in scrypt — no external deps.
 * Stored format: scrypt$<base64 salt>$<base64 hash>
 */
const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * scrypt on libuv's thread pool instead of scryptSync on the event loop. A
 * synchronous scrypt (N=16384) holds the single JS thread for tens of ms per
 * call; on a 1-CPU instance serving up to 80 concurrent requests, a burst of
 * logins stalled every in-flight sync and API request behind it.
 */
function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Constant-time equality for two secret strings. Both sides are hashed to a
 * fixed 32-byte digest first, so the comparison is timing-safe regardless of
 * length (timingSafeEqual would otherwise throw / leak on unequal lengths).
 * Returns false if either side is missing.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    // Derive to our OWN fixed KEYLEN, never the stored hash's length: a malformed
    // row can't ask scrypt for an oversized key (a DoS-amplification vector). A
    // genuine hash is always KEYLEN bytes, so the length check still rejects any
    // tampered/short hash before the constant-time compare.
    if (expected.length !== KEYLEN) return false;
    const derived = await scrypt(password, salt);
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}
