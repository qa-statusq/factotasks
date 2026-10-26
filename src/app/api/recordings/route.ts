import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError } from "@/lib/api";
import { driveConfigured } from "@/lib/google-drive";
import { RECORDING_SELECT, shapeRecording, publicRecording, missingTable, expireStaleUploads } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/** Every meeting recording, newest first (the Recordings screen). Anyone signed in. */
export async function GET(_req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  await expireStaleUploads();
  const { data, error } = await getSupabase().from("meeting_recordings").select(RECORDING_SELECT).order("created_at", { ascending: false }).limit(200);
  if (missingTable(error)) return NextResponse.json({ recordings: [], enabled: false, migration: "019" });
  if (error) return serverError(error);
  return NextResponse.json({ recordings: ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => publicRecording(shapeRecording(r))), enabled: driveConfigured() });
}
