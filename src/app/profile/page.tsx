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
import { mutate, useCachedFetch, dropEverywhere, settleDelete } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { useDialog } from "@/components/ui/dialog";
import { When } from "@/components/ui/live-time";
import { signOut } from "@/lib/signout";
import { NAME_MAX, displayName } from "@/lib/name";
import { DEPARTMENT_META, LIMITS } from "@/lib/domain";
import { useOnChange } from "@/lib/use-on-change";
import { IconUser, IconLock, IconEye, IconEyeOff, IconBell } from "@/components/ui/icons";
import { pushSupported, currentSubscription, enablePush, disablePush, needsHomeScreen, syncPush } from "@/lib/push-client";
import { NOTIFY_CATEGORIES, notifyPrefKey } from "@/lib/notify-kinds";
import { usePref } from "@/lib/use-pref";
import { Switch } from "@/components/ui/switch";
import type { Me } from "@/lib/types";

export default function ProfilePage() {
  const { loading } = useSession();
  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <PageHeader title="Profile" description="How you appear to the team, your notifications, where you are signed in, and your password." />
      {loading ? (
        <PageLoader />
      ) : (
        <>
          <AccountCard />
          <NotificationsCard />
          <SessionsCard />
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
              <span className="truncate font-semibold text-ink">{displayName(first, last) || me?.email}</span>
              <Badge tone={me?.role === "admin" ? "brand" : "neutral"} className="capitalize">
                {me?.role}
              </Badge>
              {me?.department && <Badge tone="neutral">{DEPARTMENT_META[me.department]?.label ?? me.department}</Badge>}
            </div>
            <div className="truncate text-sm text-ink-muted">{me?.email}</div>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 border-t border-line pt-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

type PushState = "checking" | "unsupported" | "homescreen" | "off" | "on" | "blocked" | "unconfigured";

/** One "notify me about" switch: a per-person choice, saved on the account (applies to every device). */
function NotifyChoice({ cat }: { cat: (typeof NOTIFY_CATEGORIES)[number] }) {
  const [on, setOn] = usePref<boolean>(notifyPrefKey(cat.key), true);
  return <Switch checked={on} onChange={setOn} label={cat.label} description={cat.hint} />;
}

function NotificationsCard() {
  const { toast } = useToast();
  const { me } = useSession();
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  async function probe(): Promise<PushState> {
    if (needsHomeScreen()) return "homescreen";
    if (!pushSupported()) return "unsupported";
    // A first visit may be registering this device right now: read the state after that run.
    if (me?.id) await syncPush(me.id);
    // "On" means THIS browser's subscription is registered to THIS account —
    // a subscription left behind by whoever used the browser before is "off".
    const sub = await currentSubscription();
    const data = await fetch(`/api/push${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ""}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled: boolean; subscribed: boolean }>) : null))
      .catch(() => null);
    if (!data) return "off";
    if (!data.enabled) return "unconfigured";
    if (Notification.permission === "denied") return "blocked";
    return sub && data.subscribed ? "on" : "off";
  }
  async function load() {
    const r = await probe();
    setState(r);
  }
  useEffect(() => {
    let alive = true;
    probe().then((r) => {
      if (!alive) return;
      setState(r);
    });
    return () => {
      alive = false;
    };
    // Re-read once the account is known (a cold load can mount this before the session arrives).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (state === "on") {
        await disablePush(me?.id);
        toast("Notifications off on this device");
      } else {
        const err = await enablePush(me?.id);
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

  async function test() {
    if (testing) return;
    setTesting(true);
    const { ok, data } = await postJson<{ sent?: number; removed?: number; error?: string }>("/api/push/test", {});
    setTesting(false);
    if (!ok) return toast(data?.error || "Couldn't send a test notification", "error");
    if (!data?.sent) {
      toast(data?.removed ? "This device's registration had expired — turn notifications on again" : "No device accepted the test — turn notifications on again", "error");
      await load();
      return;
    }
    toast("Test notification sent", "success", "Nothing appeared? Allow notifications for this browser in the device's own settings (Mac: System Settings → Notifications → your browser) and turn off Do Not Disturb / Focus.");
  }

  const copy =
    state === "unsupported" ? "This browser can't show push notifications."
    : state === "homescreen" ? "On iPhone and iPad, notifications work once FactoTasks is on the Home Screen: tap Share → Add to Home Screen, open it from there, then turn notifications on here."
    : state === "unconfigured" ? "Push isn't set up on the server yet — the in-app inbox still works."
    : state === "blocked" ? "Blocked in the browser. Allow notifications for this site in the address-bar site settings, then try again."
    : state === "on" ? "On for this device — whether the panel is open, in the background or closed. Nothing pops up while you present a meeting. Your own actions never notify you."
    : "Get a notification on this device when something needs you — assignments, approvals, comments, due dates, status changes and releases. It arrives whether the panel is open, in the background or closed.";

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <IconBell size={16} className="text-ink-subtle" /> Notifications on this device
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody>
        {/* Phones: the sentence takes the full width and the buttons sit under it. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 text-[13px] leading-relaxed text-ink-muted sm:flex-1">{copy}</p>
          {(state === "on" || state === "off") && (
            <div className="flex shrink-0 items-center gap-2">
              {state === "on" && me?.role === "admin" && (
                <Button variant="secondary" size="sm" onClick={test} disabled={testing}>
                  {testing ? <Spinner /> : "Send test"}
                </Button>
              )}
              <Button variant={state === "on" ? "secondary" : "primary"} size="sm" onClick={toggle} disabled={busy}>
                {busy ? <Spinner /> : state === "on" ? "Turn off" : "Turn on"}
              </Button>
            </div>
          )}
        </div>
        {state === "on" && (
          <div className="mt-4 border-t border-line/70 pt-4">
            <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">Notify me about</p>
            <div className="flex flex-col gap-3.5">
              {NOTIFY_CATEGORIES.map((c) => (
                <NotifyChoice key={c.key} cat={c} />
              ))}
            </div>
            <p className="mt-3 text-[12px] text-ink-subtle">Everything still appears in your Inbox; these only decide what reaches your devices.</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

interface SignIn {
  id: string;
  device: string;
  ip: string | null;
  created_at: string;
  last_seen: string;
  current: boolean;
}

/** Where this account is signed in — end one sign-in, or every other one (GitHub / Google style). */
function SessionsCard() {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { data, error, refresh } = useCachedFetch<{ sessions: SignIn[]; untracked: boolean }>("/api/auth/sessions");
  const [busy, setBusy] = useState<string | null>(null);
  const list = data?.sessions ?? [];
  const others = list.filter((x) => !x.current).length;

  async function end(x: SignIn) {
    if (x.current) {
      if (!(await confirm({ title: "Sign out of this device?", confirmLabel: "Sign out" }))) return;
      void signOut();
      return;
    }
    if (!(await confirm({ title: `Sign out ${x.device}?`, message: "That browser is signed out within a few seconds and has to sign in again.", confirmLabel: "Sign out", tone: "danger" }))) return;
    // Goes at once; comes back only if the server refuses.
    dropEverywhere(x.id, ["/api/auth/sessions"]);
    const r = await deleteJson(`/api/auth/sessions?id=${x.id}`);
    settleDelete(x.id);
    refresh();
    if (r.ok) toast(`${x.device} signed out`);
    else toast(r.data?.error || "Couldn't sign that device out", "error");
  }

  async function endOthers() {
    if (busy) return;
    if (!(await confirm({ title: "Sign out of all other devices?", message: "Every other browser and phone signed in to this account is signed out and has to sign in again. This one stays signed in.", confirmLabel: "Sign out others", tone: "danger" }))) return;
    setBusy("others");
    const keep = await currentSubscription().catch(() => null);
    const r = await postJson("/api/auth/sessions", { others: true, keep_endpoint: keep?.endpoint ?? null });
    setBusy(null);
    refresh();
    if (r.ok) toast("Signed out of all other devices");
    else toast(r.data?.error || "Couldn't sign the other devices out", "error");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <IconLock size={16} className="text-ink-subtle" /> Signed-in devices
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody>
        {error && !data ? (
          <p className="text-[13px] text-ink-muted">Couldn&rsquo;t load your sign-ins. <button type="button" onClick={refresh} className="font-medium text-ink underline-offset-2 hover:underline">Try again</button></p>
        ) : !data ? (
          <Spinner />
        ) : (
          <>
            <p className="mb-3 text-[13px] text-ink-muted">Every browser and phone signed in to your account in the last 7 days. Sign out any you don&rsquo;t recognise.</p>
            {list.length > 0 && (
              <ul className="divide-y divide-line/70 overflow-hidden rounded-lg border border-line">
                {list.map((x) => (
                  <li key={x.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium text-ink">
                        {x.device}
                        {x.current && <Badge tone="success">This device</Badge>}
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-subtle">
                        Signed in <When iso={x.created_at} relative={false} />
                        <span className="block sm:inline">
                          <span className="hidden sm:inline">{"\u00a0· "}</span>last active <When iso={x.last_seen} />
                        </span>
                        {x.ip && <span className="block sm:inline"><span className="hidden sm:inline">{"\u00a0· "}</span>{x.ip}</span>}
                      </div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => void end(x)} className="self-start sm:self-auto">
                      Sign out
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {data.untracked && <p className="mt-3 text-[12px] text-ink-subtle">This browser signed in before devices were listed here; signing out of all other devices lists it too.</p>}
            {(others > 0 || data.untracked) && (
              <div className="mt-3 flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => void endOthers()} disabled={!!busy}>
                  {busy === "others" ? <Spinner /> : "Sign out of all other devices"}
                </Button>
              </div>
            )}
          </>
        )}
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
              {/* The wrapper is positioned, so .tap (position: relative) can grow the button's hit area. */}
              <span className="absolute right-2.5 top-1/2 flex -translate-y-1/2">
                <button type="button" onClick={() => setShow((v) => !v)} className="tap rounded-md p-1 text-ink-subtle hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
                  {show ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                </button>
              </span>
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
