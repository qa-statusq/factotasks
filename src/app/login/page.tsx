"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Spinner } from "@/components/ui/misc";
import { Logo, BrandName } from "@/components/ui/logo";
import { postJson } from "@/lib/http";
import { clearAllCache } from "@/lib/client-cache";
import { IconEye, IconEyeOff, IconCheck } from "@/components/ui/icons";

const POINTS = [
  "Every app, every task, one board for the whole mobile team",
  "Members update status — an admin reviews and approves",
  "Release log per version, Android and iOS",
  "Weekly MOM: carried-forward work, ready to present",
];

/** Where to land after sign-in: a same-origin path from ?next=, else home. */
function nextPath(): string {
  try {
    const n = new URLSearchParams(window.location.search).get("next") || "";
    if (!n.startsWith("/") || /[\\\s]/.test(n)) return "/";
    // Resolve it like the browser will and keep it only if it stays here.
    const u = new URL(n, window.location.origin);
    if (u.origin !== window.location.origin || u.pathname.startsWith("/login")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const mail = email.trim();
    if (!mail || !password) {
      setError(!mail ? "Enter your email address." : "Enter your password.");
      (!mail ? emailRef : passwordRef).current?.focus();
      return;
    }
    setLoading(true);
    setError("");
    const { ok, data } = await postJson("/api/auth/login", { email: mail, password });
    if (ok) {
      // A different account may have used this tab before — nothing cached may
      // survive into this session.
      clearAllCache();
      // HARD replace: consumes the /login history entry and boots the authed
      // app in a brand-new document. Keep the spinner up while it swaps.
      window.location.replace(data?.mustChangePassword ? `/set-password?next=${encodeURIComponent(nextPath())}` : nextPath());
      return;
    }
    setLoading(false);
    setError(data?.error || "Incorrect email or password.");
  }

  return (
    <div className="flex min-h-screen supports-[min-height:1svh]:min-h-svh bg-canvas">
      {/* ── Form column ─────────────────────────────────────────────── */}
      <div className="flex w-full flex-col justify-center px-5 py-10 sm:px-12 lg:w-[46%] lg:max-w-[640px]">
        <div className="mx-auto w-full max-w-[400px]">
          <div className="mb-9 flex items-center gap-2.5">
            <Logo size={36} />
            <BrandName className="text-[18px]" />
          </div>

          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">Welcome back</h1>
          <p className="mt-1.5 text-sm text-ink-muted">Sign in to see your tasks, releases and this week&rsquo;s meeting.</p>

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
            <Field label="Email">
              <Input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError("");
                }}
                placeholder="you@company.com"
                autoFocus
                autoComplete="username"
                className="h-11"
              />
            </Field>
            <Field label="Password">
              <div className="relative">
                <Input
                  ref={passwordRef}
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  className="h-11 pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-subtle transition-colors hover:text-ink"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  title={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                </button>
              </div>
            </Field>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-100">{error}</p>}
            <Button size="lg" className="w-full" disabled={loading}>
              {loading ? <Spinner /> : "Sign in"}
            </Button>
            <p className="text-center text-xs leading-relaxed text-ink-subtle">
              New here? Your admin creates your account and shares a temporary password.
            </p>
          </form>

          <p className="mt-10 text-center text-xs text-ink-subtle lg:text-left">© Version Systems Private Limited</p>
        </div>
      </div>

      {/* ── Brand panel (desktop) ────────────────────────────────────── */}
      <div className="hidden flex-1 p-5 lg:flex">
        <div className="relative flex flex-1 flex-col justify-center overflow-hidden rounded-2xl bg-brand-900 px-14 xl:px-20">
          <div className="pointer-events-none absolute -right-40 -top-40 h-[30rem] w-[30rem] rounded-full bg-brand-700/30 blur-3xl" />
          <div className="relative max-w-sm">
            <h2 className="text-3xl font-semibold leading-snug tracking-tight text-white xl:text-[34px]">
              One place for the
              <br />
              whole mobile team.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-brand-100/80">
              Plan, build, test and ship — with every status change reviewed and every week&rsquo;s open work carried forward
              automatically.
            </p>
            <ul className="mt-12 flex flex-col gap-4">
              {POINTS.map((p) => (
                <li key={p} className="flex items-start gap-3 text-sm text-brand-100/85">
                  <IconCheck size={15} className="mt-0.5 shrink-0 text-brand-300" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <p className="absolute bottom-8 left-14 text-xs text-brand-100/40 xl:left-20">Built for Android &amp; iOS product teams</p>
        </div>
      </div>
    </div>
  );
}
