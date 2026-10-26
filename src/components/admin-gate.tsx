"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/providers/session-provider";
import { LoadError } from "@/components/ui/misc";

/** Wraps an admin-only section: members are sent to the dashboard. A session
 * that could not be loaded shows a retry instead — an admin on a flaky
 * connection must not be bounced as if they were a member. */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { me, isAdmin, loading, error, refresh } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && me && !isAdmin) router.replace("/");
  }, [loading, me, isAdmin, router]);
  if (error) return <LoadError title="Couldn't check who you are" onRetry={refresh} />;
  if (loading || !isAdmin) return null;
  return <>{children}</>;
}

/** Meetings and recordings: admins, and members who take part in at least one series. */
export function MeetingsGate({ children }: { children: React.ReactNode }) {
  const { me, isAdmin, loading, error, refresh } = useSession();
  const router = useRouter();
  const allowed = isAdmin || (me?.series_ids?.length ?? 0) > 0;
  useEffect(() => {
    if (!loading && me && !allowed) router.replace("/");
  }, [loading, me, allowed, router]);
  if (error) return <LoadError title="Couldn't check who you are" onRetry={refresh} />;
  if (loading || !allowed) return null;
  return <>{children}</>;
}
