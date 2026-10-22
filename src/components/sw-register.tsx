"use client";

import { useEffect } from "react";

/**
 * Registers the offline-fallback service worker (public/sw.js). Mounted once
 * in the root layout so every screen — login included — gets the branded
 * offline page instead of the browser's default error screen. Best-effort:
 * an engine without service workers simply keeps today's behaviour.
 */
export default function SwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration is an enhancement — never surface a failure */
    });
  }, []);
  return null;
}
