"use client";

import { useEffect } from "react";
import { useSession } from "@/components/providers/session-provider";
import { usePref } from "@/lib/use-pref";
import { THEME_COOKIE, THEME_COLORS, isTheme, type Theme } from "@/lib/theme-shared";

export type { Theme };

/**
 * Paint a theme now: the attribute the CSS keys on, the browser-chrome tint,
 * and the cookie the server reads so the NEXT page load paints the same theme
 * on its first frame (no light flash before the account preference arrives).
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  // The phone status bar follows too. The theme-color tags belong to Next.js
  // (rendered from generateViewport), so they are ONLY retinted in place —
  // never removed or added: React keeps references to them, and a node pulled
  // out from under it crashed the next page change ("removeChild" of null),
  // leaving the clicked screen stuck until a refresh. The next server render
  // (which reads the cookie set above) brings back the exact tags.
  const osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const tagDark = m.media ? m.media.includes("dark") : theme === "dark" || (theme === "system" && osDark);
    const color = theme === "system" ? (tagDark ? THEME_COLORS.dark : THEME_COLORS.light) : THEME_COLORS[theme];
    if (m.content !== color) m.content = color;
  }
}

/** The person's theme (saved on their account, so it follows them to every device) and its setter. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [raw, setPref] = usePref<string>("theme", "light");
  const theme: Theme = isTheme(raw) ? raw : "light";
  return [
    theme,
    (t: Theme) => {
      applyTheme(t); // paint first — the save runs in the background
      setPref(t);
    },
  ];
}

/**
 * Keeps the page in step with the account: a new device (or another person
 * signing in on this one) adopts the saved theme as soon as the session loads.
 */
export function ThemeSync() {
  const { me } = useSession();
  const saved = me?.prefs?.theme;
  useEffect(() => {
    if (!me) return;
    const t: Theme = isTheme(saved) ? saved : "light";
    if (document.documentElement.dataset.theme !== t || !document.cookie.includes(`${THEME_COOKIE}=${t}`)) applyTheme(t);
  }, [me, saved]);
  return null;
}
