"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { Logo, BrandName } from "@/components/ui/logo";
import { buttonClass } from "@/components/ui/button";
import { useModalChrome } from "@/components/ui/use-modal-chrome";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { DialogProvider } from "@/components/ui/dialog";
import { SessionProvider, useSession } from "@/components/providers/session-provider";
import { ClockProvider } from "@/components/providers/clock-provider";
import { TaskComposerProvider, useTaskComposer } from "@/components/task-composer";
import { useCachedFetch, prefetch } from "@/lib/client-cache";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { holdCvRender } from "@/lib/cv-restore";
import { tabMemGet, tabMemSet } from "@/lib/compat";
import { signOut } from "@/lib/signout";
import { displayName } from "@/lib/name";
import { compactCount } from "@/lib/format";
import { OFFLINE_FAVICON } from "@/lib/offline-favicon";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/misc";
import DocumentTitle from "@/components/document-title";
import { ScrollToTop } from "@/components/ui/scroll-to-top";
import { StickyContextBar } from "@/components/ui/context-bar";
import { useScrolled } from "@/lib/use-scrolled";
import { useOnChange } from "@/lib/use-on-change";
import {
  IconApps,
  IconDashboard,
  IconTasks,
  IconRocket,
  IconPresentation,
  IconUserCheck,
  IconAnalytics,
  IconUsers,
  IconActivity,
  IconSettings,
  IconHelp,
  IconKeyboard,
  IconLogout,
  IconUser,
  IconPlus,
  IconBell,
  IconChevronDown,
} from "@/components/ui/icons";

/** Which-screen-am-I context for the fixed bar that appears on scroll. Detail
 * pages (a task, an app, a meeting) show their own identity bar instead. */
function screenContext(pathname: string): { label: string; icon: React.ReactNode } | null {
  if (pathname === "/tasks") return { label: "Tasks", icon: <IconTasks size={15} /> };
  if (pathname === "/apps") return { label: "Apps", icon: <IconApps size={15} /> };
  if (pathname === "/releases") return { label: "Releases", icon: <IconRocket size={15} /> };
  if (pathname === "/meetings") return { label: "Meetings", icon: <IconPresentation size={15} /> };
  if (pathname === "/approvals") return { label: "Approvals", icon: <IconUserCheck size={15} /> };
  if (pathname === "/analytics") return { label: "Analytics", icon: <IconAnalytics size={15} /> };
  if (pathname === "/team") return { label: "People", icon: <IconUsers size={15} /> };
  if (pathname === "/activity") return { label: "Activity", icon: <IconActivity size={15} /> };
  if (pathname === "/settings") return { label: "Settings", icon: <IconSettings size={15} /> };
  if (pathname === "/notifications") return { label: "Inbox", icon: <IconBell size={15} /> };
  if (pathname === "/profile") return { label: "Profile", icon: <IconUser size={15} /> };
  if (pathname === "/guide") return { label: "Help & guide", icon: <IconHelp size={15} /> };
  if (pathname === "/shortcuts") return { label: "Keyboard shortcuts", icon: <IconKeyboard size={15} /> };
  return null;
}

function ScreenContextBar() {
  const pathname = usePathname();
  const scrolled = useScrolled(120);
  const ctx = screenContext(pathname);
  if (!ctx) return null;
  return (
    <StickyContextBar show={scrolled}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-muted ring-1 ring-inset ring-line">
        {ctx.icon}
      </span>
      <span className="truncate text-sm font-semibold text-ink">{ctx.label}</span>
    </StickyContextBar>
  );
}

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const bodyScrollLocked = () => document.body.style.overflow === "hidden";
const readScrollMap = (): Record<string, number> => {
  try {
    return JSON.parse(tabMemGet("ft:scroll") || "{}") || {};
  } catch {
    return {};
  }
};

/**
 * Owns the window scroll across route changes — replacing BOTH Next's
 * unreliable scroll-to-top and the browser's native Back/Forward restoration
 * (which re-applies the target offset while the OUTGOING screen is still
 * mounted, flashing it). Forward navigations start at the top; Back/Forward and
 * reloads land exactly where the user left — applied after commit, re-applied
 * while async data below the fold is still growing the page.
 */
function ScrollManager() {
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  const fromHistoryRef = useRef(false);
  const firstRef = useRef(true);
  const restoringRef = useRef(false);

  useEffect(() => {
    window.history.scrollRestoration = "manual";
    let raf = 0;
    const save = () => {
      if (restoringRef.current || bodyScrollLocked()) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (restoringRef.current || bodyScrollLocked()) return;
        const map = readScrollMap();
        map[pathRef.current] = window.scrollY;
        tabMemSet("ft:scroll", JSON.stringify(map));
      });
    };
    const onPop = () => {
      if (window.location.pathname !== pathRef.current) fromHistoryRef.current = true;
    };
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("scroll", save);
      window.removeEventListener("popstate", onPop);
      cancelAnimationFrame(raf);
    };
  }, []);

  useIsoLayoutEffect(() => {
    pathRef.current = pathname;
    window.history.scrollRestoration = "manual";
    const restore = fromHistoryRef.current || firstRef.current;
    fromHistoryRef.current = false;
    firstRef.current = false;
    let target = 0;
    if (restore) target = Number(readScrollMap()[pathname]) || 0;
    if (target <= 8) {
      window.scrollTo(0, target);
      return;
    }
    restoringRef.current = true;
    const releaseCv = holdCvRender();
    let done = false;
    let iv = 0;
    const finish = () => {
      if (done) return;
      done = true;
      restoringRef.current = false;
      releaseCv();
      window.clearInterval(iv);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
    };
    const cancel = () => {
      if (!bodyScrollLocked()) finish();
    };
    const started = Date.now();
    let deadline = started + 6000;
    let lastHeight = -1;
    const apply = () => {
      if (bodyScrollLocked()) {
        if (Date.now() - started > 60_000) {
          finish();
          return;
        }
        deadline = Date.now() + 6000;
        return;
      }
      const h = document.documentElement.scrollHeight;
      if (h !== lastHeight) {
        lastHeight = h;
        deadline = Date.now() + 6000;
      }
      const max = Math.max(0, h - window.innerHeight);
      window.scrollTo(0, Math.min(target, max));
      if (max >= target) {
        finish();
        return;
      }
      if (Date.now() > deadline || Date.now() - started > 60_000) finish();
    };
    apply();
    if (!done) {
      iv = window.setInterval(apply, 120);
      window.addEventListener("wheel", cancel, { passive: true });
      window.addEventListener("touchstart", cancel, { passive: true });
      window.addEventListener("pointerdown", cancel);
      window.addEventListener("keydown", cancel);
    }
    return finish;
  }, [pathname]);
  return null;
}

/**
 * Panel-wide keyboard shortcuts (documented on /shortcuts): "g then letter"
 * jumps between screens, "c" opens the task composer, "?" opens the shortcuts
 * screen. Never fires while typing or while an overlay owns the keyboard.
 */
function GlobalShortcuts({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const composer = useTaskComposer();
  const gAtRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector('[role="menu"], [role="listbox"], [aria-modal="true"]')) return;
      if (e.key === "?") {
        e.preventDefault();
        router.push("/shortcuts");
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "c" && !e.shiftKey && Date.now() - gAtRef.current > 1500) {
        e.preventDefault();
        composer.open();
        return;
      }
      if (k === "g" && !e.shiftKey) {
        gAtRef.current = Date.now();
        return;
      }
      if (Date.now() - gAtRef.current < 1500) {
        const dest: Record<string, string | undefined> = {
          d: "/",
          t: "/tasks",
          a: "/apps",
          r: "/releases",
          m: isAdmin ? "/meetings" : undefined,
          o: "/analytics",
          e: "/team",
          n: "/notifications",
          p: isAdmin ? "/approvals" : undefined,
          v: isAdmin ? "/activity" : undefined,
          s: isAdmin ? "/settings" : undefined,
          h: "/guide",
        };
        const to = dest[k];
        if (to) {
          e.preventDefault();
          gAtRef.current = 0;
          router.push(to);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, isAdmin, composer]);
  return null;
}

/* ------------------------------ connectivity ------------------------------ */

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  document.addEventListener("visibilitychange", cb);
  window.addEventListener("pageshow", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
    document.removeEventListener("visibilitychange", cb);
    window.removeEventListener("pageshow", cb);
  };
}

/** Connection-status strip. Participates in LAYOUT (publishes --offline-h on
 * <html>); on reconnect flips green for a beat while caches revalidate. */
function NetworkStrip() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [reconnected, setReconnected] = useState(false);
  useOnChange(online, () => setReconnected(online));
  useEffect(() => {
    if (!reconnected) return;
    const t = window.setTimeout(() => setReconnected(false), 2500);
    return () => window.clearTimeout(t);
  }, [reconnected]);
  const state: "online" | "offline" | "reconnected" = !online ? "offline" : reconnected ? "reconnected" : "online";
  useEffect(() => {
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel*="icon"]');
    if (!links.length) return;
    if (state === "offline") {
      links.forEach((l) => {
        if (!l.dataset.onlineHref) l.dataset.onlineHref = l.href;
        l.href = OFFLINE_FAVICON;
      });
    } else {
      links.forEach((l) => {
        if (l.dataset.onlineHref) {
          l.href = l.dataset.onlineHref;
          delete l.dataset.onlineHref;
        }
      });
    }
  }, [state]);
  useEffect(() => {
    document.documentElement.style.setProperty("--offline-h", state === "online" ? "0px" : "36px");
    return () => {
      document.documentElement.style.setProperty("--offline-h", "0px");
    };
  }, [state]);
  if (state === "online") return null;
  const offline = state === "offline";
  return (
    <div
      role="status"
      className={cn("fixed inset-x-0 top-0 z-30 flex h-9 items-center px-4 text-xs font-semibold text-white lg:left-64", offline ? "bg-amber-500" : "bg-emerald-500")}
    >
      <StripMessage
        icon={
          offline ? (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )
        }
        text={offline ? "You’re offline — changes won’t save until you reconnect, and data may be out of date." : "Back online — refreshing your data."}
      />
    </div>
  );
}

function StripMessage({ icon, text }: { icon: React.ReactNode; text: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = wrapRef.current;
      const m = measureRef.current;
      if (!w || !m) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setRolling(!reduced && m.offsetWidth > w.clientWidth + 1);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [text]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0">{icon}</span>
      <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden">
        {rolling ? (
          <div className="flex w-max animate-offline-marquee whitespace-nowrap">
            <span className="pr-16">{text}</span>
            <span className="pr-16" aria-hidden>
              {text}
            </span>
          </div>
        ) : (
          <span className="block truncate text-center">{text}</span>
        )}
        <span ref={measureRef} aria-hidden className="invisible absolute left-0 top-0 whitespace-nowrap">
          {text}
        </span>
      </div>
      <span className="w-[14px] shrink-0" aria-hidden />
    </div>
  );
}

/* ------------------------------- profile ---------------------------------- */

function ProfileMenu({
  me,
  active,
  onLogout,
  onNavigate,
}: {
  me: { email?: string; role?: string; first_name?: string | null; last_name?: string | null; color?: string; title?: string | null } | null;
  active: boolean;
  onLogout: () => void;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const name = displayName(me?.first_name, me?.last_name);
  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div role="menu" aria-label="Account menu" className="absolute inset-x-0 bottom-[calc(100%+8px)] z-10 animate-scale-in overflow-hidden rounded-xl border border-line/80 bg-surface shadow-pop ring-1 ring-ink/5">
          <div className="border-b border-line px-3.5 py-2.5">
            <div className="truncate text-sm font-semibold text-ink">{name || me?.email || "…"}</div>
            <div className="truncate text-xs text-ink-subtle">
              {name && me?.email ? <>{me.email} · </> : null}
              <span className="capitalize">{me?.role || ""}</span>
            </div>
          </div>
          <div className="p-1">
            <Link href="/guide" role="menuitem" onClick={() => { setOpen(false); onNavigate(); }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink">
              <IconHelp size={16} />
              Help & guide
            </Link>
            <Link href="/shortcuts" role="menuitem" onClick={() => { setOpen(false); onNavigate(); }} className="hidden items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink lg:flex">
              <IconKeyboard size={16} />
              Keyboard shortcuts
            </Link>
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink"
            >
              <IconUser size={16} />
              View profile
            </Link>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <IconLogout size={16} />
              Sign out
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={me?.email || undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left transition-colors",
          open || active ? "border-brand-200 bg-canvas/60" : "border-line hover:bg-canvas"
        )}
      >
        <Avatar user={me} size="lg" className="h-9 w-9 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{name || me?.email || "…"}</div>
          <div className="truncate text-[11px] leading-snug text-ink-subtle">{me?.title || <span className="capitalize">{me?.role || ""}</span>}</div>
        </div>
        <IconChevronDown size={15} className={cn("shrink-0 text-ink-subtle transition-transform", open ? "rotate-0" : "rotate-180")} />
      </button>
    </div>
  );
}

function MobileDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useModalChrome(onClose);
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
      <div className="absolute inset-0 bg-ink/55" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-slide-in-left rounded-r-2xl border-r border-line/80 bg-surface shadow-pop ring-1 ring-ink/5">{children}</aside>
    </div>
  );
}

/* -------------------------------- shell ----------------------------------- */

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === "/login" || pathname === "/set-password";
  // The presentation deck is full-screen by design: no sidebar, no header.
  const presenting = /^\/meetings\/[^/]+\/(present|print)$/.test(pathname);

  if (bare)
    return (
      <ToastProvider>
        <DialogProvider>{children}</DialogProvider>
      </ToastProvider>
    );

  return (
    <ToastProvider>
      <DialogProvider>
        <SessionProvider>
          <ClockProvider>
            <TaskComposerProvider>{presenting ? children : <Shell>{children}</Shell>}</TaskComposerProvider>
          </ClockProvider>
        </SessionProvider>
      </DialogProvider>
    </ToastProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me, isAdmin } = useSession();
  const { toast } = useToast();
  const composer = useTaskComposer();
  // One tiny call feeds the inbox badge, the approvals badge and the tab title.
  const { data: counts } = useCachedFetch<{ unread?: number; approvals?: number }>("/api/notifications?limit=1");
  const unread = counts?.unread || 0;
  const approvals = counts?.approvals || 0;
  // Teammates' changes show up within a poll interval on whatever is on screen.
  useLiveUpdates();

  // bfcache guard: Safari restores fully-authed page snapshots even against
  // no-store — after a logout, Back could revive a frozen view of the dead
  // session. Reload so the proxy re-decides against the CURRENT session.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  useOnChange(pathname, () => {
    setDrawerOpen(false);
    setPending(null);
  });
  useEffect(() => {
    if (pending === null) return;
    const t = window.setTimeout(() => setPending(null), 12_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  // Close the drawer if the viewport crosses lg while it is open (it is hidden
  // by CSS there, but its body-scroll lock would remain).
  useEffect(() => {
    if (!drawerOpen) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    sync();
    if (mq.addEventListener) mq.addEventListener("change", sync);
    else mq.addListener(sync);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", sync);
      else mq.removeListener(sync);
    };
  }, [drawerOpen]);

  const [signingOut, setSigningOut] = useState(false);
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    const attempted = await signOut();
    if (!attempted) {
      setSigningOut(false);
      toast("You're offline — reconnect, then sign out.", "error");
    }
  }

  const item = (href: string, label: string, icon: React.ReactNode, active: boolean, trailing?: React.ReactNode, prefetchUrls?: string[]) => {
    const warm = prefetchUrls ? () => prefetchUrls.forEach(prefetch) : undefined;
    const isActive = pending !== null ? pending === href : active;
    return (
      <Link
        href={href}
        onPointerEnter={warm}
        onPointerDown={warm}
        onClick={() => {
          if (pathname !== href) setPending(href);
          setDrawerOpen(false);
        }}
        className={cn(
          "group relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors duration-150 [@media(min-height:54rem)]:py-[7px]",
          isActive ? "bg-brand-100/70 font-semibold text-ink" : "text-ink-muted hover:bg-ink/[0.04] hover:text-ink active:bg-ink/[0.07]"
        )}
      >
        {isActive && <span className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-ink" />}
        <span className={cn("transition-colors", isActive ? "text-ink" : "text-ink-subtle group-hover:text-ink-muted")}>{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {trailing}
      </Link>
    );
  };

  const groupLabel = (text: string) => (
    <div className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-subtle/90 [@media(min-height:54rem)]:pt-4">{text}</div>
  );

  const countBadge = (n: number, tone: "amber" | "brand" = "amber") =>
    n > 0 ? (
      <span
        title={String(n)}
        className={cn(
          "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums ring-1 ring-inset",
          tone === "amber" ? "bg-amber-100 text-amber-800 ring-amber-600/15" : "bg-ink text-white ring-ink"
        )}
      >
        {compactCount(n)}
      </span>
    ) : null;

  const Nav = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 pb-2">
        <Link
          href="/"
          onClick={() => {
            setPending("/");
            setDrawerOpen(false);
          }}
          className="flex items-center gap-2.5 px-5 pb-3 pt-4 [@media(min-height:54rem)]:pb-4 [@media(min-height:54rem)]:pt-5"
        >
          <Logo size={32} />
          <BrandName />
        </Link>
        <div className="px-3 pb-1">
          <button
            type="button"
            onPointerDown={() => {
              prefetch("/api/users");
              prefetch("/api/apps");
            }}
            onClick={() => {
              setDrawerOpen(false);
              composer.open();
            }}
            className={buttonClass("primary", "md", "w-full justify-center")}
          >
            <IconPlus size={16} /> New task
          </button>
        </div>
      </div>

      <nav className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-0.5">
        {groupLabel("Work")}
        <div className="flex flex-col gap-1 [@media(min-height:54rem)]:gap-1.5">
          {item("/", "Dashboard", <IconDashboard size={18} />, pathname === "/", undefined, ["/api/dashboard"])}
          {item("/tasks", "Tasks", <IconTasks size={18} />, pathname === "/tasks" || pathname.startsWith("/tasks/"), undefined, ["/api/tasks?scope=open", "/api/apps", "/api/users"])}
          {item("/apps", "Apps", <IconApps size={18} />, pathname === "/apps" || pathname.startsWith("/apps/"), undefined, ["/api/apps"])}
          {item("/releases", "Releases", <IconRocket size={18} />, pathname === "/releases", undefined, ["/api/releases", "/api/apps"])}
          {isAdmin && item("/meetings", "Meetings", <IconPresentation size={18} />, pathname === "/meetings" || pathname.startsWith("/meetings/"), undefined, ["/api/meetings"])}
          {isAdmin && item("/approvals", "Approvals", <IconUserCheck size={18} />, pathname === "/approvals", countBadge(approvals), ["/api/tasks?scope=approvals"])}
          {item("/analytics", "Analytics", <IconAnalytics size={18} />, pathname === "/analytics", undefined, [])}
        </div>

        {groupLabel("Team")}
        <div className="flex flex-col gap-1 [@media(min-height:54rem)]:gap-1.5">
          {item("/team", "People", <IconUsers size={18} />, pathname === "/team", undefined, ["/api/team"])}
          {item("/notifications", "Inbox", <IconBell size={18} />, pathname === "/notifications", countBadge(unread, "brand"), ["/api/notifications?limit=30"])}
          {isAdmin && item("/activity", "Activity", <IconActivity size={18} />, pathname === "/activity")}
          {isAdmin && item("/settings", "Settings", <IconSettings size={18} />, pathname === "/settings", undefined, ["/api/settings"])}
        </div>
      </nav>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 [@media(min-height:54rem)]:gap-2">
        <ProfileMenu me={me} active={pathname === "/profile"} onLogout={logout} onNavigate={() => setDrawerOpen(false)} />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen supports-[min-height:1svh]:min-h-svh pt-[var(--offline-h,0px)] transition-[padding] duration-300 motion-reduce:transition-none">
      <DocumentTitle />
      <NetworkStrip />
      {pending !== null && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] h-0.5 overflow-hidden" role="progressbar" aria-label="Loading page">
          <div className="h-full w-1/3 rounded-full bg-brand-500 animate-nav-progress motion-reduce:animate-pulse" />
        </div>
      )}
      {signingOut && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/80 px-6" role="status" aria-live="polite">
          <div className="flex items-center gap-3 rounded-xl border border-line/80 bg-surface px-5 py-3.5 shadow-pop ring-1 ring-ink/5">
            <Spinner className="text-brand-600" />
            <span className="text-sm font-medium text-ink">Signing out…</span>
          </div>
        </div>
      )}
      <ScreenContextBar />
      <ScrollToTop />
      <ScrollManager />
      <GlobalShortcuts isAdmin={!!isAdmin} />
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line/70 bg-surface lg:block">{Nav}</aside>

      {drawerOpen && <MobileDrawer onClose={() => setDrawerOpen(false)}>{Nav}</MobileDrawer>}

      <header className="glass sticky top-[var(--offline-h,0px)] z-20 flex items-center justify-between border-b border-line/70 px-4 py-3 transition-[top] duration-300 motion-reduce:transition-none lg:hidden">
        <div className="flex items-center gap-1">
          <button onClick={() => setDrawerOpen(true)} className="tap [--tap:40px] rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink" aria-label="Open menu">
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <BrandName />
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/notifications" aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"} className="tap relative rounded-md p-1.5 text-ink-muted hover:bg-canvas hover:text-ink">
            <IconBell size={20} />
            {unread > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-brand-600 ring-2 ring-surface" />}
          </Link>
          <Link href="/profile" aria-label="Profile" title="Profile" className="rounded-full p-0.5 transition-shadow hover:ring-2 hover:ring-brand-200">
            <Avatar user={me} size="md" />
          </Link>
        </div>
      </header>

      <main className="flex min-h-screen supports-[min-height:1svh]:min-h-svh min-w-0 flex-col pb-[var(--bottom-bar-h,0px)] lg:pl-64">
        <div className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 overflow-x-clip px-4 py-6 sm:px-6 sm:py-8 lg:px-10 xl:px-14">{children}</div>
        <footer className="border-t border-line/70 px-4 py-5 sm:px-6 lg:px-10 xl:px-14">
          <div className="mx-auto flex max-w-[1600px] items-center gap-2 text-xs text-ink-subtle">
            <Logo size={16} className="opacity-80" />
            <span className="font-medium">FactoTasks</span>
            <span className="text-line">·</span>© Version Systems Private Limited
          </div>
        </footer>
      </main>
    </div>
  );
}
