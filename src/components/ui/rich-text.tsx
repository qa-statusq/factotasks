import Link from "next/link";
import { Fragment } from "react";
import { cn } from "@/lib/cn";

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)|(\bT-\d+\b)/g;

/**
 * Plain text, rendered well: paragraphs preserved, long strings wrapped,
 * http(s) links clickable (new tab, no referrer) and T-123 references linked
 * to their task. No markdown engine — nothing to sanitise, nothing to ship.
 * Text is React-escaped; the only elements created are our own <a>/<Link>.
 */
export function RichText({ text, className, taskLinks = true }: { text: string | null | undefined; className?: string; taskLinks?: boolean }) {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(<Fragment key={key++}>{text.slice(last, idx)}</Fragment>);
    const tok = m[0];
    if (m[1]) {
      // Trailing punctuation belongs to the sentence, not the link.
      const trimmed = tok.replace(/[.,;:!?]+$/, "");
      const tail = tok.slice(trimmed.length);
      parts.push(
        <a key={key++} href={trimmed} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800">
          {trimmed}
        </a>
      );
      if (tail) parts.push(<Fragment key={key++}>{tail}</Fragment>);
    } else if (taskLinks) {
      parts.push(
        <Link key={key++} href={`/tasks/${tok.slice(2)}`} className="font-medium text-brand-700 hover:underline">
          {tok}
        </Link>
      );
    } else {
      parts.push(<Fragment key={key++}>{tok}</Fragment>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <div className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed text-ink", className)}>{parts}</div>;
}
