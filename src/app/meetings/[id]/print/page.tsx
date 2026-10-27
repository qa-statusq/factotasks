"use client";

import { Suspense, useEffect, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";

import { MinutesDoc, type Pack } from "./minutes-doc";

/**
 * Minutes of meeting as a document: A4, black on white, one running header,
 * app by app. Opened from the meeting page in its own tab; prints itself
 * once the data is in. Everything the deck shows, in reading order.
 */
export default function PrintPage() {
  return (
    <Suspense fallback={null}>
      <PrintDoc />
    </Suspense>
  );
}

function PrintDoc() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const auto = sp.get("auto") !== "0";
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/meetings/${id}`);
  useDocumentTitle(data ? `${data.meeting.title} · Minutes` : "Minutes");

  const printed = useRef(false);
  useEffect(() => {
    if (!auto || !data || printed.current) return;
    // Print once fonts and every app icon are in, so the PDF never shows blank tiles.
    // Once only: a background refresh of the pack must not re-open the dialog.
    let cancelled = false;
    const t = window.setTimeout(async () => {
      await Promise.race([settleAssets(), new Promise((r) => setTimeout(r, 5000))]);
      if (cancelled || printed.current) return;
      printed.current = true;
      window.print();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [auto, data]);

  if (loading) return <Shell>Preparing the minutes…</Shell>;
  if (error && !data)
    return (
      <Shell>
        <span className="flex flex-col items-center gap-3">
          Couldn&rsquo;t load this meeting.
          <button type="button" onClick={() => refresh()} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white">Try again</button>
        </span>
      </Shell>
    );
  if (!data) return null;
  return <MinutesDoc pack={data} onBack={() => router.push(`/meetings/${data.meeting.id}`)} />;
}

/** Resolves when fonts are ready and every image on the page has loaded (or failed) and decoded. */
async function settleAssets() {
  await document.fonts?.ready;
  await Promise.all(
    Array.from(document.images).map(async (img) => {
      if (!img.complete) await new Promise<void>((r) => { img.addEventListener("load", () => r(), { once: true }); img.addEventListener("error", () => r(), { once: true }); });
      if (img.naturalWidth) await img.decode().catch(() => undefined);
    }),
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center bg-[#e9e8e4] text-sm text-ink-muted">{children}</div>;
}
