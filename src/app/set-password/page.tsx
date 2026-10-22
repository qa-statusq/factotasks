"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Spinner } from "@/components/ui/misc";
import { Logo } from "@/components/ui/logo";
import { postJson } from "@/lib/http";
import { signOut } from "@/lib/signout";
import { IconEye, IconEyeOff } from "@/components/ui/icons";

export default function SetPasswordPage() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Sign-out and set-password are mutually exclusive: both end in a hard
    // navigation, and set-password issues a NEW session cookie — letting them
    // overlap means the winner decides whether you end up signed in or out.
    // (The shell has no equivalent race: its sign-out overlay covers the UI.)
    if (leaving || loading) return;
    setError("");
    if (pw.length < 8) return setError("Password must be at least 8 characters.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setLoading(true);
    const { ok, data } = await postJson("/api/auth/set-password", { password: pw });
    if (ok) {
      // Hard replace — boots the authed app in a fresh document and consumes
      // this screen's history entry (same rationale as the login page).
      // Lands where the sign-in was headed (same-origin paths only).
      let next = "/";
      try {
        const n = new URLSearchParams(window.location.search).get("next") || "";
        const u = new URL(n, window.location.origin);
        if (n.startsWith("/") && !/[\\\s]/.test(n) && u.origin === window.location.origin && !u.pathname.startsWith("/login") && !u.pathname.startsWith("/set-password")) next = u.pathname + u.search + u.hash;
      } catch {}
      window.location.replace(next);
      return;
    }
    setLoading(false);
    setError(data?.error || "Could not set password.");
  }

  // Exactly the shell's sign-out (shared helper): cookie cleared server-side,
  // caches wiped, hard teardown to /login — with the navigation fallback for
  // machines where the XHR is blocked. Only an offline browser comes back.
  const [leaving, setLeaving] = useState(false);
  async function leave() {
    if (leaving || loading) return; // see submit() — mutually exclusive
    setLeaving(true);
    setError("");
    if (!(await signOut())) {
      setLeaving(false);
      setError("You're offline — reconnect, then sign out.");
    }
  }

  return (
    // svh, not vh: 100vh on iOS is the address-bar-hidden height, which left a
    // dead scroll strip under the panel on every phone.
    <div className="relative flex min-h-screen supports-[min-height:1svh]:min-h-svh items-center justify-center overflow-hidden bg-canvas px-4">
      <div className="pointer-events-none absolute -left-40 -top-40 h-96 w-96 rounded-full bg-brand-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-brand-100/50 blur-3xl" />

      <div className="relative w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo size={52} className="mb-4" />
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">Set your password</h1>
          <p className="mt-1.5 text-sm text-ink-muted">Choose a new password to finish setting up your account.</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-7 shadow-pop">
          <Field label="New password">
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-subtle transition-colors hover:text-ink"
                aria-label={show ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {show ? <IconEyeOff size={18} /> : <IconEye size={18} />}
              </button>
            </div>
          </Field>
          <Field label="Confirm new password">
            <Input
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter the password"
              autoComplete="new-password"
            />
          </Field>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-100">{error}</p>
          )}
          <Button size="lg" className="w-full" disabled={loading || leaving}>
            {loading ? <Spinner /> : "Set password & continue"}
          </Button>
          <button
            type="button"
            onClick={leave}
            disabled={leaving || loading}
            className="w-full text-center text-xs text-ink-subtle transition-colors hover:text-ink disabled:opacity-60"
          >
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </form>
      </div>
    </div>
  );
}
