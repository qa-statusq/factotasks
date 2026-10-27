import { NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { rateLimited } from "@/lib/rate-limit";
import { pushToUsers } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * Send a test notification to every device of the caller — the Profile
 * screen's "Send test" button. Answers how many devices the push service
 * accepted it for, so a silent device can be told apart from a silent server.
 */
export async function POST() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const limited = await rateLimited(u.uid, "push-test", 5, 60);
  if (limited) return limited;
  const { count } = await getSupabase().from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", u.uid);
  if (!count) return NextResponse.json({ devices: 0, sent: 0, failed: 0, removed: 0 });
  const r = await pushToUsers([u.uid], { title: "FactoTasks", body: "Test notification — this device will be told when something needs you.", url: "/notifications", tag: "push-test" });
  return NextResponse.json({ devices: count, ...r });
}
