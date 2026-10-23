"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, controlClass } from "@/components/ui/field";
import { Dropdown } from "@/components/ui/dropdown";
import { Sheet } from "@/components/ui/sheet";
import { PageHeader, LoadError, EmptyState, Spinner } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { AppTile } from "@/components/ui/task-chips";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, mutate } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { NAME_MAX } from "@/lib/name";
import { DEPARTMENTS, DEPARTMENT_META, LIMITS, type Department } from "@/lib/domain";
import { IconUsers, IconPlus, IconSearch, IconEye, IconEyeOff, IconMore } from "@/components/ui/icons";
import type { TeamMember } from "@/lib/types";

const DEPT_OPTIONS = DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_META[d].label }));
const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

export default function TeamPage() {
  const { isAdmin, me } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ members: TeamMember[] }>("/api/team");
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const members = data?.members ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q ? members.filter((m) => `${m.name} ${m.email ?? ""} ${m.title ?? ""} ${DEPARTMENT_META[m.department]?.label ?? ""}`.toLowerCase().includes(q)) : members;
  const groups = useMemo(() => {
    const g = new Map<Department, TeamMember[]>();
    for (const m of filtered) g.set(m.department, [...(g.get(m.department) || []), m]);
    return DEPARTMENTS.filter((d) => g.has(d)).map((d) => [d, g.get(d)!] as const);
  }, [filtered]);
  const active = members.filter((m) => m.is_active).length;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="People"
        description={`${active} people across ${new Set(members.filter((m) => m.is_active).map((m) => m.department)).size} departments.`}
        actions={
          isAdmin ? (
            <Button onClick={() => setInviting(true)}>
              <IconPlus size={16} /> Add teammate
            </Button>
          ) : undefined
        }
      />
      {loading ? (
        <ListSkeleton rows={7} />
      ) : error && !data ? (
        <LoadError title="Couldn't load the team" onRetry={refresh} />
      ) : (
        <>
          {members.length > 6 && (
            <div className="relative w-full sm:max-w-sm">
              <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people…" aria-label="Search people" className={cn(controlClass, "h-9 pl-9")} />
            </div>
          )}
          {groups.length === 0 ? (
            <EmptyState icon={<IconUsers size={20} />} title={q ? `No one matches “${query}”` : "No teammates yet"} />
          ) : (
            groups.map(([dept, list]) => (
              <Card key={dept} className="overflow-hidden">
                <CardHeader>
                  <CardTitle>
                    {DEPARTMENT_META[dept].label} <span className="ml-1 text-sm font-normal text-ink-subtle">{list.length}</span>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line/80">
                  {list.map((m) => (
                    <li key={m.id} className={cn("flex items-center gap-4 px-4 py-3.5 sm:px-5", !m.is_active && "opacity-60")}>
                      <Avatar user={m} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[14px] font-semibold text-ink">{m.name}</span>
                          {m.role === "admin" && <Badge tone="brand">Admin</Badge>}
                          {!m.is_active && <Badge tone="neutral">Deactivated</Badge>}
                          {m.id === me?.id && <span className="text-xs text-ink-subtle">(you)</span>}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-ink-subtle">
                          {m.title ? `${m.title} · ` : ""}
                          {isAdmin ? m.email : DEPARTMENT_META[m.department]?.label ?? ""}
                          {isAdmin && m.last_login_at && (
                            <span title={istTime(m.last_login_at)}>
                              {" "}
                              · active <RelTime iso={m.last_login_at} />
                            </span>
                          )}
                          {isAdmin && m.must_change_password && <span className="text-amber-700"> · hasn&rsquo;t set a password yet</span>}
                        </div>
                        {m.apps.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {m.apps.map((a) => (
                              <Link key={a.id} href={`/apps/${a.id}`} className="inline-flex items-center gap-1 rounded-md bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-line hover:text-ink">
                                <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-4 w-4 rounded-[4px] text-[7px]" /> {a.name}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                      {isAdmin && (
                        <Link href={`/tasks?assignee=${m.id}`} className="hidden shrink-0 text-right text-xs text-ink-subtle hover:text-ink sm:block" title="Open their tasks">
                          <span className="block text-sm font-semibold tabular-nums text-ink">{m.open}</span>
                          open{m.overdue ? <span className="text-red-600"> · {m.overdue} late</span> : ""}
                        </Link>
                      )}
                      {isAdmin && (
                        <button type="button" onClick={() => setEditing(m)} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label={`Manage ${m.name}`}>
                          <IconMore size={18} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )}
        </>
      )}
      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
      {editing && <MemberSheet member={editing} meId={me?.id} onClose={() => setEditing(null)} />}
    </div>
  );
}

function reloadTeam() {
  mutate("/api/team");
  mutate("/api/users");
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const { confirm } = useDialog();
  const [role, setRole] = useState("member");
  const [department, setDepartment] = useState<string>("android");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };

  function generate() {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const arr = new Uint32Array(12);
    crypto.getRandomValues(arr);
    setPassword(Array.from(arr, (n) => chars[n % chars.length]).join(""));
    setShow(true);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await postJson("/api/users", { first_name: first, last_name: last, email, password, role, department, title });
    setBusy(false);
    if (ok) {
      reloadTeam();
      try {
        await navigator.clipboard?.writeText(password);
      } catch {
        /* clipboard may be unavailable */
      }
      await confirm({ title: `${first} added`, message: `Temporary password: ${password}\n\nIt has been copied to your clipboard — share it with them; they'll set their own on first sign-in.`, confirmLabel: "Done", cancelLabel: null });
      onClose();
    } else setError(data?.error || "Couldn't add the teammate.");
  }

  return (
    <Sheet
      title="Add teammate"
      description="They sign in with this temporary password and must set their own before using the panel."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : "Add teammate"}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <Input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={NAME_MAX} autoFocus autoComplete="off" />
          </Field>
          <Field label="Last name">
            <Input value={last} onChange={(e) => setLast(e.target.value)} maxLength={NAME_MAX} autoComplete="off" />
          </Field>
        </div>
        <Field label="Work email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" />
        </Field>
        <Field label="Temporary password" hint="At least 8 characters. They'll be asked to change it on first sign-in.">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="pr-10" />
              <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-subtle hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
                {show ? <IconEyeOff size={18} /> : <IconEye size={18} />}
              </button>
            </div>
            <Button type="button" variant="secondary" onClick={generate}>
              Generate
            </Button>
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Department">
            <Dropdown value={department} onChange={setDepartment} options={DEPT_OPTIONS} />
          </Field>
          <Field label="Role">
            <Dropdown value={role} onChange={setRole} options={ROLE_OPTIONS} />
          </Field>
        </div>
        <Field label="Designation" hint="Optional — e.g. Senior Android Developer">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.userTitle} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

function MemberSheet({ member: m, meId, onClose }: { member: TeamMember; meId?: string; onClose: () => void }) {
  const { toast } = useToast();
  const { confirm, prompt } = useDialog();
  const [first, setFirst] = useState(m.first_name ?? "");
  const [last, setLast] = useState(m.last_name ?? "");
  const [role, setRole] = useState(m.role);
  const [department, setDepartment] = useState<string>(m.department);
  const [title, setTitle] = useState(m.title ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const isMe = m.id === meId;

  async function patch(body: Record<string, unknown>, okMsg: string, key = "save") {
    if (busy) return false;
    setBusy(key);
    const { ok, data } = await postJson(`/api/users/${m.id}`, body, "PATCH");
    setBusy(null);
    if (ok) {
      toast(okMsg);
      reloadTeam();
      return true;
    }
    toast(data?.error || "Couldn't update", "error");
    return false;
  }

  async function save() {
    if (await patch({ first_name: first, last_name: last, role, department, title }, "Teammate updated")) onClose();
  }
  async function reset() {
    const pw = await prompt({ title: `Reset ${m.name}'s password`, message: "Set a temporary password; they'll be asked to change it on next sign-in. All their sessions are signed out.", placeholder: "Temporary password (min 8)", type: "text", minLength: 8, confirmLabel: "Reset" });
    if (pw === null) return;
    await patch({ password: pw }, "Password reset — share the temporary password", "reset");
  }
  async function toggleActive() {
    const next = !m.is_active;
    if (!next && !(await confirm({ title: `Deactivate ${m.name}?`, message: "They can't sign in; their tasks and history stay. You can re-activate anytime.", confirmLabel: "Deactivate", tone: "danger" }))) return;
    if (await patch({ is_active: next }, next ? "Re-activated" : "Deactivated", "active")) onClose();
  }
  async function remove() {
    if (!(await confirm({ title: `Remove ${m.name} entirely?`, message: "Prefer deactivation — it keeps their name on old tasks and comments. Removal is permanent.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy("remove");
    const { ok, data } = await deleteJson(`/api/users/${m.id}`);
    setBusy(null);
    if (ok) {
      toast("Teammate removed");
      reloadTeam();
      onClose();
    } else toast(data?.error || "Couldn't remove", "error");
  }

  return (
    <Sheet
      title={m.name}
      description={m.email}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {!isMe && (
              <Button variant="secondary" size="sm" onClick={toggleActive} disabled={!!busy}>
                {busy === "active" ? <Spinner /> : m.is_active ? "Deactivate" : "Re-activate"}
              </Button>
            )}
            {!isMe && (
              <Button variant="danger" size="sm" onClick={remove} disabled={!!busy}>
                {busy === "remove" ? <Spinner /> : "Remove"}
              </Button>
            )}
          </div>
          <Button onClick={save} disabled={!!busy}>
            {busy === "save" ? <Spinner /> : "Save"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <Input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={NAME_MAX} />
          </Field>
          <Field label="Last name">
            <Input value={last} onChange={(e) => setLast(e.target.value)} maxLength={NAME_MAX} />
          </Field>
          <Field label="Department">
            <Dropdown value={department} onChange={setDepartment} options={DEPT_OPTIONS} />
          </Field>
          <Field label="Role" hint={isMe ? "You can't change your own role." : undefined}>
            <Dropdown value={role} onChange={(v) => setRole(v as "admin" | "member")} options={ROLE_OPTIONS} disabled={isMe} />
          </Field>
        </div>
        <Field label="Designation">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.userTitle} placeholder="e.g. QA Engineer" />
        </Field>
                <div className="rounded-xl border border-line p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-ink">Password</div>
              <div className="text-xs text-ink-subtle">{m.must_change_password ? "Temporary password still in use." : "Set by the teammate."}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={reset} disabled={!!busy || isMe} title={isMe ? "Change your own password from Profile" : undefined}>
              {busy === "reset" ? <Spinner /> : "Reset"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-ink-subtle">
          Joined {istTime(m.created_at).replace(/, .*$/, "")}
          {m.last_login_at && (
            <>
              {" "}
              · last active <RelTime iso={m.last_login_at} />
            </>
          )}
        </p>
      </div>
    </Sheet>
  );
}
