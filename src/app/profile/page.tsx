"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { PageHeader, Spinner, PageLoader } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/components/providers/session-provider";
import { mutate } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { NAME_MAX } from "@/lib/name";
import { DEPARTMENT_META, LIMITS } from "@/lib/domain";
import { useOnChange } from "@/lib/use-on-change";
import { IconUser, IconLock, IconEye, IconEyeOff, IconBell } from "@/components/ui/icons";
import { pushSupported, currentSubscription, enablePush, disablePush } from "@/lib/push-client";
import type { Me } from "@/lib/types";

export default function ProfilePage() {
  const { loading } = useSession();
  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <PageHeader title="Profile" description="How you appear to the team, and your password." />
      {loading ? (
        <PageLoader />
      ) : (
        <>
          <AccountCard />
          <NotificationsCard />
          <ChangePasswordCard />
        </>
      )}
    </div>
  );
}

function AccountCard() {
  const { me } = useSession();
  const { toast } = useToast();
  // Start from the loaded profile (the page only renders this card once the
  // session is in), and follow later changes to it.
  const [first, setFirst] = useState(me?.first_name || "");
  const [last, setLast] = useState(me?.last_name || "");
  const [title, setTitle] = useState(me?.title || "");
  const [busy, setBusy] = useState(false);
  useOnChange(`${me?.first_name}|${me?.last_name}|${me?.title}`, () => {
    setFirst(me?.first_name || "");
    setLast(me?.last_name || "");
    setTitle(me?.title || "");
  });
  const dirty = first !== (me?.first_name || "") || last !== (me?.last_name || "") || title !== (me?.title || "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const { ok, data } = await postJson<{ user?: Me; error?: string }>("/api/auth/me", { first_name: first, last_name: last, title }, "PATCH");
    setBusy(false);
    if (ok) {
      toast("Profile updated");
      if (data?.user) mutate("/api/auth/me", { user: data.user });
      else mutate("/api/auth/me");
      mutate("/api/users");
      mutate("/api/team");
    } else toast(data?.error || "Couldn't update your profile", "error");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <IconUser size={16} className="text-ink-subtle" /> Account
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar user={{ ...me, first_name: first || me?.first_name, last_name: last || me?.last_name, color: me?.color }} size="xl" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold text-ink">{[first, last].filter(Boolean).join(" ") || me?.email}</span>
              <Badge tone={me?.role === "admin" ? "brand" : "neutral"} className="capitalize">
                {me?.role}
              </Badge>
              {me?.department && <Badge tone="neutral">{DEPARTMENT_META[me.department]?.label ?? me.department}</Badge>}
            </div>
            <div className="truncate text-sm text-ink-muted">{me?.email}</div>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 border-t border-line pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name">
              <Input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={NAME_MAX} autoComplete="given-name" />
            </Field>
            <Field label="Last name">
              <Input value={last} onChange={(e) => setLast(e.target.value)} maxLength={NAME_MAX} autoComplete="family-name" />
            </Field>
          </div>
          <Field label="Designation" hint="e.g. Senior iOS Developer — shown under your name.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.userTitle} />
          </Field>
          <div className="flex justify-end">
            <Button disabled={!dirty || busy}>{busy ? <Spinner /> : "Save"}</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

type PushState = "checking" | "unsupported" | "off" | "on" | "blocked" | "unconfigured";

function NotificationsCard() {
  const { toast } = useToast();
  const [state, setState] = useState<PushState>("checking");
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);

  async function probe(): Promise<{ state: PushState; devices: number }> {
    if (!pushSupported()) return { state: "unsupported", devices: 0 };
    // "On" means THIS browser's subscription is registered to THIS account —
    // a subscription left behind by whoever used the browser before is "off".
    const sub = await currentSubscription();
    const data = await fetch(`/api/push${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ""}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled: boolean; subscribed: boolean; devices: number }>) : null))
      .catch(() => null);
    if (!data) return { state: "off", devices: 0 };
    if (!data.enabled) return { state: "unconfigured", devices: 0 };
    if (Notification.permission === "denied") return { state: "blocked", devices: data.devices };
    return { state: sub && data.subscribed ? "on" : "off", devices: data.devices };
  }
  async function load() {
    const r = await probe();
    setState(r.state);
    setDevices(r.devices);
  }
  useEffect(() => {
    let alive = true;
    probe().then((r) => {
      if (!alive) return;
      setState(r.state);
      setDevices(r.devices);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (state === "on") {
        await disablePush();
        toast("Notifications off on this device");
      } else {
        const err = await enablePush();
        if (err) toast(err, "error");
        else toast("You'll get notifications on this device");
      }
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't change notifications", "error");
    } finally {
      setBusy(false);
    }
  }

  const copy =
    state === "unsupported" ? "This browser can't show push notifications."
    : state === "unconfigured" ? "Push isn't set up on the server yet — the in-app inbox still works."
    : state === "blocked" ? "Blocked in the browser. Allow notifications for this site in the address-bar site settings, then try again."
    : state === "on" ? "On for this device. Assignments, approvals, comments and releases reach you even when the tab is closed."
    : "Get a push alert on this device when something needs you — assignments, approval requests, comments, releases.";

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <IconBell size={16} className="text-ink-subtle" /> Browser notifications
          </span>
        </CardTitle>
        {state === "on" && devices > 1 && <Badge tone="neutral">{devices} devices</Badge>}
      </CardHeader>
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">{copy}</p>
          {(state === "on" || state === "off") && (
            <Button variant={state === "on" ? "secondary" : "primary"} size="sm" onClick={toggle} disabled={busy} className="shrink-0">
              {busy ? <Spinner /> : state === "on" ? "Turn off" : "Turn on"}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ChangePasswordCard() {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError("New password must be at least 8 characters.");
    if (next !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    // The other devices are signed out; their push subscriptions go with them.
    const keep = await currentSubscription().catch(() => null);
    const { ok, data } = await postJson("/api/auth/password", { current, next, keep_endpoint: keep?.endpoint ?? null });
    setBusy(false);
    if (ok) {
      toast("Password changed — other devices were signed out");
      setCurrent("");
      setNext("");
      setConfirm("");
    } else setError(data?.error || "Couldn't change the password.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <IconLock size={16} className="text-ink-subtle" /> Password
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
          <Field label="Current password">
            <Input type={show ? "text" : "password"} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password">
            <div className="relative">
              <Input type={show ? "text" : "password"} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" className="pr-10" />
              <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-subtle hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
                {show ? <IconEyeOff size={18} /> : <IconEye size={18} />}
              </button>
            </div>
          </Field>
          <Field label="Confirm new password">
            <Input type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <div className="flex justify-end">
            <Button disabled={busy || !current || !next}>{busy ? <Spinner /> : "Change password"}</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
