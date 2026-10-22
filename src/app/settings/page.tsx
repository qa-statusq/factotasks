"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { PageHeader, LoadError, Spinner } from "@/components/ui/misc";
import { PanelSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, mutate } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { useOnChange } from "@/lib/use-on-change";
import { cn } from "@/lib/cn";
import type { Settings } from "@/lib/settings";

const POLICIES: { value: Settings["approval_policy"]["mode"]; label: string; hint: string }[] = [
  { value: "done_only", label: "Review completions only", hint: "Members move tasks freely; marking Done or Cancelled waits for an admin. The default — low friction, with a check where it matters." },
  { value: "all", label: "Review every status change", hint: "Every member status change (even To do → In progress) waits for approval. Strict; expect a bigger queue." },
  { value: "none", label: "No review", hint: "Members apply any status directly. Admins still see everything in Activity." },
];

export default function SettingsPage() {
  const router = useRouter();
  const { me, isAdmin, loading: sessionLoading, error: sessionError, refresh: sessionRefresh } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ settings: Settings }>(isAdmin ? "/api/settings" : null);
  // Members are sent home from an effect, never from render (React warns about
  // updating the Router while this component renders).
  useEffect(() => {
    if (!sessionLoading && me && !isAdmin) router.replace("/");
  }, [sessionLoading, me, isAdmin, router]);
  if (sessionError) return <LoadError title="Couldn't check who you are" onRetry={sessionRefresh} />;
  if (!sessionLoading && !isAdmin) return null;
  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <PageHeader title="Settings" description="Workspace-wide rules. Changes apply immediately for everyone." />
      {loading || sessionLoading ? <PanelSkeleton /> : error && !data ? <LoadError onRetry={refresh} /> : data ? <SettingsForm settings={data.settings} /> : null}
    </div>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const { toast } = useToast();
  const [mode, setMode] = useState(settings.approval_policy.mode);
  const [name, setName] = useState(settings.workspace_name);
  const [busy, setBusy] = useState(false);
  useOnChange(settings, () => {
    setMode(settings.approval_policy.mode);
    setName(settings.workspace_name);
  });
  const dirty = mode !== settings.approval_policy.mode || name !== settings.workspace_name;

  async function save() {
    if (busy) return;
    setBusy(true);
    const { ok, data } = await postJson("/api/settings", { approval_policy: { mode }, workspace_name: name }, "PATCH");
    setBusy(false);
    if (ok) {
      toast("Settings saved");
      mutate("/api/settings");
    } else toast(data?.error || "Couldn't save", "error");
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Approval policy</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {POLICIES.map((p) => (
            <label key={p.value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors", mode === p.value ? "border-brand-300 bg-brand-50/50" : "border-line hover:bg-canvas")}>
              <input type="radio" name="policy" value={p.value} checked={mode === p.value} onChange={() => setMode(p.value)} className="mt-1 accent-brand-600" />
              <span>
                <span className="block text-sm font-medium text-ink">{p.label}</span>
                <span className="block text-xs leading-relaxed text-ink-muted">{p.hint}</span>
              </span>
            </label>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardBody>
          <Field label="Team name" hint="Shown on the meeting deck's title slide.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="sm:max-w-sm" />
          </Field>
        </CardBody>
      </Card>
      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy}>
          {busy ? <Spinner /> : "Save settings"}
        </Button>
      </div>
    </>
  );
}
