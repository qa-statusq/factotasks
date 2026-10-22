"use client";

import { useDocumentTitle } from "@/lib/use-document-title";

/**
 * Set the browser-tab title for a screen that cannot export `metadata`.
 *
 * Every normal route gets its title from the `layout.tsx` beside the page, which
 * is server-rendered and so correct on the FIRST paint. `not-found.tsx` is the
 * one exception — Next does not accept metadata from a not-found component — so
 * the 404 sets its title here instead. See useDocumentTitle for why simply
 * assigning document.title is not enough.
 */
export default function TabTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}
