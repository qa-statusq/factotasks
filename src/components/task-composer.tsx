"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { closeForNavigation } from "@/components/ui/use-modal-chrome";
import { TaskFormSheet, type TaskFormValues, type TargetRef } from "@/components/task-form";
import { useToast } from "@/components/ui/toast";
import { mutate, mutatePrefix } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import type { Platform, Priority, TaskType } from "@/lib/domain";
import type { TaskCard } from "@/lib/types";

interface ComposerDefaults {
  /** Pre-select an app; with `platform` one target, with "both"/none every platform the app has. */
  app_id?: string | null;
  platform?: Platform | null;
  /** Explicit targets win over app_id/platform. */
  targets?: TargetRef[];
  assignee_ids?: string[];
  type?: TaskType;
  priority?: Priority;
  /** Link the matching target to this version right after creation. */
  release_id?: string | null;
  /** Called with the created task (e.g. a list that wants to react). */
  onCreated?: (task: TaskCard) => void;
}

const Ctx = createContext<{ open: (d?: ComposerDefaults) => void }>({ open: () => {} });

/** Open the global "New task" sheet from anywhere (sidebar, pages, the `c` key). */
export function useTaskComposer() {
  return useContext(Ctx);
}

export function TaskComposerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ key: number; defaults: ComposerDefaults } | null>(null);
  const open = useCallback((defaults: ComposerDefaults = {}) => setState((s) => ({ key: (s?.key ?? 0) + 1, defaults })), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {state && <Composer key={state.key} defaults={state.defaults} onClose={() => setState(null)} />}
    </Ctx.Provider>
  );
}

function initialTargets(d: ComposerDefaults): TargetRef[] {
  if (d.targets) return d.targets;
  if (!d.app_id) return [];
  if (d.platform === "android" || d.platform === "ios") return [{ app_id: d.app_id, platform: d.platform }];
  // "both" / unknown: the server trims to the platforms the app really has.
  return [
    { app_id: d.app_id, platform: "android" },
    { app_id: d.app_id, platform: "ios" },
  ];
}

function Composer({ defaults, onClose }: { defaults: ComposerDefaults; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();

  async function create(values: TaskFormValues, open: boolean): Promise<string | null> {
    const { ok, data } = await postJson<{ task?: TaskCard; error?: string }>("/api/tasks", { ...values, release_id: defaults.release_id ?? null });
    if (!ok || !data?.task) return data?.error || "Couldn't create the task.";
    // Every list that could contain it, plus the dashboard counts.
    mutatePrefix("/api/tasks");
    mutatePrefix("/api/releases");
    mutate("/api/dashboard");
    mutate("/api/apps");
    defaults.onCreated?.(data.task);
    toast(`Task T-${data.task.number} created`);
    if (open) closeForNavigation();
    onClose();
    if (open) router.push(`/tasks/${data.task.id}`);
    return null;
  }

  return (
    <TaskFormSheet
      mode="create"
      initial={{
        targets: initialTargets(defaults),
        assignee_ids: defaults.assignee_ids ?? [],
        type: defaults.type,
        priority: defaults.priority,
      }}
      onClose={onClose}
      onSubmit={(v) => create(v, false)}
      secondaryLabel="Create & open"
      onSecondary={(v) => create(v, true)}
    />
  );
}
