"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { IconBell, IconX } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/components/providers/session-provider";
import { enablePush, pushConfigured, pushOptedOut, pushPromptSnoozed, pushSupported, snoozePushPrompt, syncPush } from "@/lib/push-client";

const noop = () => () => {};

/**
 * Keeps this device registered for notifications, and asks once where the
 * browser has never been asked.
 *  - Notifications already allowed here: the device is registered to the
 *    signed-in account silently (no prompt, no click) on every load.
 *  - Never asked on this device: a quiet one-line card at the top of the page
 *    offers to turn them on; "Not now" hides it for two weeks.
 *  - Blocked, unsupported, or turned off on Profile: nothing is shown.
 */
export function PushPrompt() {
  const { me } = useSession();
  const { toast } = useToast();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const uid = me?.id ?? null;

  // Client-only facts, read without a mount effect (server render: hidden).
  const askable = useSyncExternalStore(
    noop,
    () => !!uid && pushSupported() && pushConfigured() && Notification.permission === "default" && !pushOptedOut(uid) && !pushPromptSnoozed(uid),
    () => false
  );

  useEffect(() => {
    if (uid) void syncPush(uid);
  }, [uid]);

  if (!uid || !askable || hidden) return null;

  async function turnOn() {
    if (!uid || busy) return;
    setBusy(true);
    const err = await enablePush(uid);
    setBusy(false);
    if (err) {
      toast(err, "error");
      snoozePushPrompt(uid);
    } else toast("You'll get notifications on this device");
    setHidden(true);
  }

  return (
    <div className="mb-5 flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-muted animate-fade-in">
      <IconBell size={16} className="shrink-0 text-ink-subtle" />
      <p className="min-w-0 flex-1">Get a notification on this device when something needs you — assignments, approvals, comments and releases.</p>
      <Button size="sm" onClick={turnOn} disabled={busy} className="shrink-0">
        {busy ? <Spinner /> : "Turn on"}
      </Button>
      <button
        type="button"
        onClick={() => {
          snoozePushPrompt(uid);
          setHidden(true);
        }}
        className="shrink-0 rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink"
        aria-label="Not now"
        title="Not now"
      >
        <IconX size={15} />
      </button>
    </div>
  );
}
