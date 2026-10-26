import { createSign } from "node:crypto";

/**
 * Google Drive through a SERVICE ACCOUNT — the panel's own robot identity,
 * a Content manager of the team's Shared Drive. No OAuth, no consent screen,
 * nobody connects anything: the key is a server secret like the Supabase one.
 *
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's JSON, as one line
 *   GOOGLE_DRIVE_ID              the Shared Drive the recordings live in
 *
 * Uploads are resumable (8 MiB chunks relayed by the API), playback and
 * download stream through the panel with Range support, sharing adds a Drive
 * permission for the e-mail (Google sends the invitation).
 */

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive";

/** Chunk size for resumable uploads: a multiple of 256 KiB, well under Cloud Run's 32 MiB request limit. */
export const DRIVE_CHUNK_BYTES = 8 * 1024 * 1024;

interface ServiceKey {
  client_email: string;
  private_key: string;
}

let keyCache: ServiceKey | null | undefined;
function serviceKey(): ServiceKey | null {
  if (keyCache !== undefined) return keyCache;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return (keyCache = null);
  try {
    const k = JSON.parse(raw) as Partial<ServiceKey>;
    keyCache = k.client_email && k.private_key ? { client_email: k.client_email, private_key: k.private_key.replace(/\\n/g, "\n") } : null;
  } catch {
    keyCache = null;
  }
  return keyCache;
}

export function driveId(): string | null {
  return process.env.GOOGLE_DRIVE_ID?.trim() || null;
}

/** True when both the key and the Shared Drive are configured. */
export function driveConfigured(): boolean {
  return !!serviceKey() && !!driveId();
}

export function driveRobotEmail(): string | null {
  return serviceKey()?.client_email ?? null;
}

let tokenCache: { token: string; exp: number } | null = null;
const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

/** A bearer token for the robot (cached until a minute before it expires). */
export async function driveToken(): Promise<string> {
  const key = serviceKey();
  if (!key) throw new Error("Recording storage is not configured");
  if (tokenCache && tokenCache.exp - 60_000 > Date.now()) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google token: ${j.error_description || j.error || r.status}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await driveToken()}`, ...extra };
}

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function driveErr(r: Response, what: string): Promise<DriveError> {
  let detail = "";
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? "";
  } catch {
    /* no body */
  }
  return new DriveError(r.status, `${what} failed (${r.status})${detail ? `: ${detail}` : ""}`);
}

const folderCache = new Map<string, string>();
/** The id of a folder with this name at the Shared Drive's root — created on first use, remembered afterwards. */
export async function ensureFolder(name: string): Promise<string> {
  const parent = driveId();
  if (!parent) throw new Error("Recording storage is not configured");
  const cached = folderCache.get(name);
  if (cached) return cached;
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&corpora=drive&driveId=${encodeURIComponent(parent)}&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id)`, { headers: await authHeaders() });
  if (!found.ok) throw await driveErr(found, "Looking up the folder");
  const files = ((await found.json()) as { files?: { id: string }[] }).files ?? [];
  let id = files[0]?.id;
  if (!id) {
    const made = await fetch(`${DRIVE}/files?supportsAllDrives=true&fields=id`, { method: "POST", headers: await authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }) });
    if (!made.ok) throw await driveErr(made, "Creating the folder");
    id = ((await made.json()) as { id: string }).id;
  }
  folderCache.set(name, id);
  return id;
}

/** Upload a whole small file (≤ a few tens of MB) in one multipart request; returns the file id. */
export async function uploadBytes(name: string, mime: string, bytes: Uint8Array, parentId: string): Promise<string> {
  const boundary = `ft${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType: mime })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const r = await fetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, { method: "POST", headers: await authHeaders({ "content-type": `multipart/related; boundary=${boundary}`, "content-length": String(body.length) }), body });
  if (!r.ok) throw await driveErr(r, "Uploading the file");
  return ((await r.json()) as { id: string }).id;
}

/** Open a resumable upload session in the Shared Drive; returns the session URI (valid for a week). */
export async function createUploadSession(name: string, mime: string, totalBytes: number | null): Promise<string> {
  const parent = driveId();
  if (!parent) throw new Error("Recording storage is not configured");
  const r = await fetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, ...(totalBytes ? { "x-upload-content-length": String(totalBytes) } : {}) }),
    body: JSON.stringify({ name, parents: [parent], mimeType: mime }),
  });
  if (!r.ok) throw await driveErr(r, "Starting the upload");
  const uri = r.headers.get("location");
  if (!uri) throw new DriveError(500, "Google returned no upload session");
  return uri;
}

export interface ChunkResult {
  done: boolean;
  /** Bytes Google has so far (next chunk starts here). */
  received: number;
  file?: { id: string; name: string; size?: string; mimeType?: string };
}

/**
 * Relay one chunk of the file to its upload session. `total` is null while the
 * recording is still running (Google accepts "bytes a-b/*"); the last chunk
 * carries the real total. An empty body with a total closes an upload whose
 * bytes have all arrived already.
 */
export async function uploadChunk(sessionUri: string, body: ArrayBuffer, offset: number, total: number | null): Promise<ChunkResult> {
  const end = offset + body.byteLength - 1;
  const range = body.byteLength ? `bytes ${offset}-${end}/${total ?? "*"}` : `bytes */${total}`;
  const r = await fetch(sessionUri, {
    method: "PUT",
    headers: { "content-length": String(body.byteLength), "content-range": range },
    body: body.byteLength ? body : undefined,
  });
  if (r.status === 308) {
    const range = r.headers.get("range"); // "bytes=0-8388607"
    const received = range ? Number(range.split("-")[1]) + 1 : Math.max(0, end + 1);
    return { done: false, received };
  }
  if (r.ok) {
    const file = (await r.json()) as ChunkResult["file"];
    return { done: true, received: total ?? offset + body.byteLength, file };
  }
  throw await driveErr(r, "Uploading");
}

/** Where an interrupted upload stands, so the browser can resume. */
export async function uploadStatus(sessionUri: string, total: number | null): Promise<ChunkResult> {
  const r = await fetch(sessionUri, { method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${total ?? "*"}` } });
  if (r.status === 308) {
    const range = r.headers.get("range");
    return { done: false, received: range ? Number(range.split("-")[1]) + 1 : 0 };
  }
  if (r.ok) return { done: true, received: total ?? 0, file: (await r.json()) as ChunkResult["file"] };
  throw await driveErr(r, "Checking the upload");
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string | null;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
}

export async function getFile(fileId: string): Promise<DriveFile | null> {
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,videoMediaMetadata`, { headers: await authHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw await driveErr(r, "Reading the file");
  const j = (await r.json()) as Omit<DriveFile, "size"> & { size?: string };
  return { ...j, size: Number(j.size ?? 0), webViewLink: j.webViewLink ?? null };
}

/** The file's bytes, honouring a Range header so <video> can seek. */
export async function streamFile(fileId: string, range: string | null): Promise<Response> {
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: await authHeaders(range ? { range } : {}) });
  if (!r.ok && r.status !== 206) throw await driveErr(r, "Streaming the file");
  return r;
}

export async function renameFile(fileId: string, name: string): Promise<void> {
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "PATCH", headers: await authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ name }) });
  if (!r.ok) throw await driveErr(r, "Renaming");
}

/** Move to the Shared Drive's bin (one call; a Content manager may not delete outright, and the bin empties itself after 30 days). */
export async function trashFile(fileId: string): Promise<void> {
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "PATCH", headers: await authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ trashed: true }) });
  if (!r.ok && r.status !== 404) throw await driveErr(r, "Deleting");
}

/** Give one e-mail address read access; Google e-mails the invitation (with the message). Returns the permission id. */
export async function shareFile(fileId: string, email: string, message: string | null): Promise<string> {
  const q = new URLSearchParams({ supportsAllDrives: "true", sendNotificationEmail: "true", fields: "id" });
  if (message) q.set("emailMessage", message);
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?${q}`, {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ role: "reader", type: "user", emailAddress: email }),
  });
  if (!r.ok) throw await driveErr(r, "Sharing");
  return ((await r.json()) as { id: string }).id;
}

export async function unshareFile(fileId: string, permissionId: string): Promise<void> {
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, { method: "DELETE", headers: await authHeaders() });
  if (!r.ok && r.status !== 404) throw await driveErr(r, "Removing access");
}
