"use client";

import { useRef, useState } from "react";
import { buttonClass } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { downloadInPieces } from "@/lib/fetch-pieces";
import { LIMITS } from "@/lib/domain";
import { IconDownload, IconX } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * Download a file the panel serves. Up to one piece (16 MiB) it is a plain
 * link — the browser's own download, nothing held in the page. Bigger files
 * come down in pieces with the progress on the button (and can be stopped);
 * see lib/fetch-pieces.
 */
export function DownloadButton({ url, name, size, variant = "secondary", label = "Download", className, iconOnly, plain }: {
  url: string;
  name: string;
  size: number;
  variant?: "primary" | "secondary";
  label?: string;
  className?: string;
  iconOnly?: boolean;
  /** Use only `className` (no button look) — for dark surfaces like the file viewer. */
  plain?: boolean;
}) {
  const { toast } = useToast();
  const [pct, setPct] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  const cls = plain ? cn("inline-flex items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors", className) : cn(buttonClass(variant, "sm"), className);

  if (size <= LIMITS.servePieceBytes)
    return (
      <a href={href} className={cls} download={name} aria-label={iconOnly ? `Download ${name}` : undefined} title={iconOnly ? "Download" : undefined}>
        <IconDownload size={14} /> {!iconOnly && <span className="hidden sm:inline">{label}</span>}
      </a>
    );

  async function start() {
    if (ctrl.current) {
      ctrl.current.abort(); // a second press stops it
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setPct(0);
    try {
      const saved = await downloadInPieces(href, name, { signal: c.signal, onProgress: (loaded, total) => setPct(total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0) });
      if (saved) toast(`Downloaded ${name}`);
    } catch {
      if (!c.signal.aborted) toast(`Couldn't download ${name} — check the connection and try again`, "error");
      else toast("Download stopped");
    } finally {
      ctrl.current = null;
      setPct(null);
    }
  }

  return (
    <button type="button" onClick={start} className={cls} title={pct !== null ? "Stop the download" : `Download (${Math.round(size / 1048576)} MB)`} aria-label={pct !== null ? `Downloading ${name}, ${pct}% — press to stop` : `Download ${name}`}>
      {pct !== null ? (
        <>
          <IconX size={14} /> <span className="tabular-nums">{pct}%</span>
        </>
      ) : (
        <>
          <IconDownload size={14} /> {!iconOnly && <span className="hidden sm:inline">{label}</span>}
        </>
      )}
    </button>
  );
}
