import { cleanLine, cleanText, cleanUrl, isHexColor, isPackageId, oneOf } from "./validate";
import { LIMITS } from "./domain";

/** Validate the editable app fields shared by create and update. Returns the
 * cleaned patch or an error message. `partial` = only keys present in `b`. */
export function appPatch(b: Record<string, unknown>, partial: boolean): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};
  const has = (k: string) => !partial || k in b;

  if (has("name")) {
    const name = cleanLine(b.name, LIMITS.appName);
    if (!name) return { error: "Enter the app's name" };
    patch.name = name;
  }
  if (has("description")) patch.description = cleanText(b.description, LIMITS.appDescription) || null;
  if (has("kind") && (partial || b.kind != null)) {
    const kind = oneOf(b.kind, ["b2c", "b2b"] as const);
    if (!kind) return { error: "kind must be b2c or b2b" };
    patch.kind = kind;
  }
  if (has("status") && (partial || b.status != null)) {
    const status = oneOf(b.status, ["active", "maintenance", "archived"] as const);
    if (!status) return { error: "Pick a valid status" };
    patch.status = status;
  }
  if (has("has_android") || has("has_ios")) {
    for (const k of ["has_android", "has_ios"]) {
      if (k in b && typeof b[k] !== "boolean") return { error: `${k} must be true or false` };
    }
    if ("has_android" in b) patch.has_android = b.has_android;
    if ("has_ios" in b) patch.has_ios = b.has_ios;
  }
  if (has("android_package")) {
    const pkg = cleanLine(b.android_package, 150);
    if (pkg && !isPackageId(pkg)) return { error: "Android package must look like com.example.app" };
    patch.android_package = pkg || null;
  }
  if (has("ios_bundle_id")) {
    const bid = cleanLine(b.ios_bundle_id, 150);
    if (bid && !isPackageId(bid)) return { error: "iOS bundle id must look like com.example.app" };
    patch.ios_bundle_id = bid || null;
  }
  if (has("appstore_url")) {
    const raw = cleanLine(b.appstore_url, 400);
    if (raw) {
      const url = cleanUrl(raw);
      if (!url) return { error: "App Store link must be a full https:// URL" };
      patch.appstore_url = url;
    } else patch.appstore_url = null;
  }
  if (has("color")) {
    if (b.color != null && b.color !== "" && !isHexColor(b.color)) return { error: "Pick a valid colour" };
    if (isHexColor(b.color)) patch.color = String(b.color).toLowerCase();
  }
  return { patch };
}

