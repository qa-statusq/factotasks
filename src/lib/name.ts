/**
 * Shared user-name helpers (client + server — pure, no environment access).
 *
 * Security posture: names are free-form human text, so the server never
 * restricts the alphabet (names are diverse) but ALWAYS stores them clean —
 * control characters stripped, internal whitespace collapsed, length-capped.
 * Rendering is React-escaped everywhere, so stored names carry no HTML/JS
 * injection surface; the cap bounds DB rows; names never enter the session
 * token (they're read DB-fresh via the auth cache), so a rename needs no
 * re-login and can't bloat the JWT.
 */
export const NAME_MAX = 60;

/** Invisible or text-reordering characters. Stripped so a name can never be
 * blank-looking or spoof the text around it — U+00AD soft hyphen, U+200B
 * zero-width space, U+200E/U+200F LRM/RLM, U+202A-U+202E bidi embeddings and
 * overrides (Trojan-Source), U+2060-U+206F word joiner / invisible operators /
 * bidi isolates, U+FEFF BOM.
 * DELIBERATELY KEPT: U+200C ZWNJ and U+200D ZWJ — both are orthographically
 * load-bearing in Devanagari/Gujarati/Persian (they block conjunct and ligature
 * formation) and ZWJ joins emoji sequences, so stripping them silently corrupts
 * legitimate names. The VISIBLE guard below covers the blank-identity case they
 * were previously stripped for. */
const INVISIBLE = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** At least one character that actually paints. Format joiners and blank glyphs
 * (braille blank, Hangul filler, Mongolian vowel separator) do not count: a
 * name made only of those passes a non-empty check yet renders as no identity
 * at all. */
const VISIBLE = /[^\s\u200c\u200d\u180e\u2800\u3164]/;

/** Normalize one name field: strip control chars, collapse whitespace, cap. */
export function cleanName(v: unknown): string {
  const out = String(v ?? "")
    // Controls become SPACES first (a tab/newline BETWEEN names must separate
    // them, not weld them), then all whitespace collapses to one.
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    // The cap can split a surrogate pair (emoji at the boundary) — drop the
    // dangling half rather than store a lone surrogate.
    .replace(/[\ud800-\udbff]$/, "")
    .trim();
  return VISIBLE.test(out) ? out : "";
}

/** "First Last" (or just "First") — null when no name is set, so callers can
 * fall back to the email. */
export function displayName(first?: string | null, last?: string | null): string | null {
  const full = [first, last]
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join(" ");
  return full || null;
}

/** Avatar initials: "RS" from first+last name, "R" from first only, else the
 * email's first letter. Array.from = code-point safe (never half an emoji). */
export function nameInitials(first?: string | null, last?: string | null, email?: string | null): string {
  const f = Array.from((first || "").trim())[0] || "";
  const l = Array.from((last || "").trim())[0] || "";
  const fromName = (f + l).toUpperCase();
  return fromName || (Array.from((email || "").trim())[0] || "?").toUpperCase();
}
