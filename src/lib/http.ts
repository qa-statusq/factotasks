import { syncRevAfterOwnWrite } from "@/lib/use-live-updates";
/**
 * One-liner JSON POST/PATCH/PUT/DELETE for the client. Replaces the repeated
 *   fetch(url, { method, headers: { "Content-Type": "application/json" },
 *               body: JSON.stringify(body) })
 * + manual res.json() pattern. Each caller keeps its own success/error handling;
 * this only removes the request boilerplate.
 *
 *   const { ok, data } = await postJson("/api/x", body);
 *   if (ok) toast("Saved"); else toast(data?.error || "Failed", "error");
 */
import { timeoutSignal } from "@/lib/compat";

// Pause before retrying an idempotent write whose request got no response.
const WRITE_RETRY_PAUSE_MS = 600;

interface JsonResult<T> {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or null if the response had no/!invalid JSON. */
  data: T;
}

/** JSON DELETE — same result shape as postJson. */
export function deleteJson<T = { error?: string } & Record<string, unknown>>(url: string): Promise<JsonResult<T>> {
  return postJson<T>(url, undefined, "DELETE");
}

export async function postJson<T = { error?: string } & Record<string, unknown>>(
  url: string,
  body?: unknown,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
  // Per-call ceiling. It MUST exceed the target route's own budget: the AI
  // routes declare maxDuration 30/60 and deliberately spend it (sleeping out a
  // provider's 429 cooldown inside their deadlineAt), so the old fixed 20s cap
  // sat BELOW the server's designed window — every slow-but-successful
  // generation was completed, paid for, then thrown away by the client and
  // mislabelled "Network error — check your connection".
  timeoutMs = 20_000
): Promise<JsonResult<T>> {
  // NEVER throws. A network failure/timeout resolves to { ok:false, status:0 }
  // like any other failed request — so the 20+ call sites can't strand a busy
  // spinner or fire an unhandled rejection when the connection drops mid-
  // submit. The 20s timeout stops a silently-dropped socket from pinning a
  // button forever.
  const send = () =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // timeoutSignal, not AbortSignal.timeout: this file runs on old-browser
      // clients, where the native call is a TypeError (pre-Chrome 103) that
      // turned EVERY save into "Network error".
      signal: timeoutSignal(timeoutMs),
    });

  let res: Response;
  try {
    res = await send();
  } catch {
    // The request never got an answer. For an IDEMPOTENT method that is worth
    // one more try: re-applying the identical patch is a no-op if the first
    // attempt did land, and a save is much more likely to succeed on a second
    // try than the user is to be told "Network error" and retype their work.
    //
    // PATCH/PUT ONLY, deliberately. POST creates things (an app, a reply, an AI
    // generation) and DELETE's second attempt would answer "not found" for a
    // removal that actually succeeded — for both, a silent retry could do or
    // report the wrong thing, so they keep failing honestly and let the user
    // decide.
    if (method !== "PATCH" && method !== "PUT") {
      return { ok: false, status: 0, data: { error: "Network error — check your connection and try again." } as T };
    }
    await new Promise((r) => setTimeout(r, WRITE_RETRY_PAUSE_MS));
    try {
      res = await send();
    } catch {
      return { ok: false, status: 0, data: { error: "Network error — check your connection and try again." } as T };
    }
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null as T;
  }
  if (res.ok) syncRevAfterOwnWrite();
  return { ok: res.ok, status: res.status, data };
}
