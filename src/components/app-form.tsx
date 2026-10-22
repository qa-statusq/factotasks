"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { mutate, mutatePrefix } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { LIMITS } from "@/lib/domain";
import type { AppOverview } from "@/lib/types";


/** Create / edit an app (admin only). */
export function AppFormSheet({ app, onClose, onSaved }: { app?: AppOverview | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(app?.name ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [android, setAndroid] = useState(app?.has_android ?? true);
  const [ios, setIos] = useState(app?.has_ios ?? false);
  const [pkg, setPkg] = useState(app?.android_package ?? "");
  const [bundle, setBundle] = useState(app?.ios_bundle_id ?? "");
  const [storeUrl, setStoreUrl] = useState(app?.appstore_url ?? "");
  const [busy, setBusy] = useState(false);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };

  async function save() {
    if (busy) return;
    if (!name.trim()) return setError("Enter the app's name.");
    if (!android && !ios) return setError("Pick at least one platform.");
    setBusy(true);
    setError("");
    const body = {
      name: name.trim(),
      description,
      has_android: android,
      has_ios: ios,
      android_package: android ? pkg : "",
      ios_bundle_id: ios ? bundle : "",
      appstore_url: ios ? storeUrl : "",
    };
    const { ok, data } = app
      ? await postJson<{ error?: string }>(`/api/apps/${app.id}`, body, "PATCH")
      : await postJson<{ app?: { id: string }; error?: string }>("/api/apps", body);
    if (!ok) {
      setBusy(false);
      setError(data?.error || "Couldn't save the app.");
      return;
    }
    toast(app ? "App updated" : "App added");
    mutate("/api/apps");
    if (app) mutate(`/api/apps/${app.id}`);
    mutatePrefix("/api/tasks");
    onSaved?.(app ? app.id : (data as { app?: { id: string } }).app?.id ?? "");
    onClose();
  }

  return (
    <Sheet
      title={app ? "Edit app" : "Add app"}
      description="Platforms decide which tasks and releases the app can hold."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : app ? "Save changes" : "Add app"}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SwapMyFace" maxLength={LIMITS.appName} autoFocus className="h-11 text-[15px]" />
        </Field>
        <Field label="Description" hint="What the app does, in a line or two.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={LIMITS.appDescription} />
        </Field>
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
          <Switch checked={android} onChange={setAndroid} label="Android" description="Ships on Google Play" />
          {android && <Input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="Package id — com.example.app" />}
          <Switch checked={ios} onChange={setIos} label="iOS" description="Ships on the App Store" />
          {ios && (
            <>
              <Input value={bundle} onChange={(e) => setBundle(e.target.value)} placeholder="Bundle id — com.example.app" />
              <Input value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} placeholder="App Store link (https://apps.apple.com/…)" />
            </>
          )}
        </div>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}
