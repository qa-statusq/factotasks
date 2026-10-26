/**
 * Compact a count for a small badge/chip so a large number can never widen or
 * break the layout: 0–999 stay as-is, then 1.2k / 12k / 1.2M / 12M. Keeps every
 * badge to at most ~4 characters, on mobile and desktop — the industry-standard
 * badge treatment. Every call site pairs it with the EXACT count in the
 * element's tooltip (title), so the true number is always one hover away and
 * wide layouts (analytics, tables) keep rendering exact values directly.
 */
export function compactCount(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    // 999,500+ rounds to 1000k — promote to the next unit instead.
    if (Math.round(k) >= 1000) return "1M";
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, "") : String(Math.round(k))) + "k";
  }
  const m = v / 1_000_000;
  if (Math.round(m) >= 1000) return "1B";
  return (m < 10 ? m.toFixed(1).replace(/\.0$/, "") : String(Math.round(m))) + "M";
}

/** "812 KB", "4.2 MB", "1.3 GB" — one byte formatter for attachments and recordings. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

