/**
 * Server-side input hygiene. Every route cleans untrusted text through these
 * before it touches the database: control characters stripped, whitespace
 * normalised, lengths capped. Rendering is React-escaped everywhere, so stored
 * text carries no HTML/JS injection surface; the caps bound DB rows and
 * response payloads.
 */
import { isYmd } from "./ist";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

const HEX_RE = /^#[0-9a-f]{6}$/i;
export const isHexColor = (s: unknown): s is string => typeof s === "string" && HEX_RE.test(s);

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invisible / bidi-override characters (Trojan-Source class). ZWNJ/ZWJ are
 * kept: load-bearing in Devanagari/Gujarati and emoji sequences. */
const INVISIBLE = /[­​‎‏‪-‮⁠-⁯﻿]/g;

/** Multi-line text (descriptions, comments, notes): keeps newlines/tabs, strips
 * every other control char, trims, caps. Returns "" when empty. */
export function cleanText(v: unknown, max: number): string {
  if (v == null) return "";
  return String(v)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(INVISIBLE, "")
    .replace(/[ \t]+\n/g, "\n") // trailing whitespace per line
    .replace(/\n{4,}/g, "\n\n\n") // never more than two blank lines
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "") // dangling surrogate half at the cap
    .trim();
}

/** Single-line text (titles, names, versions): all whitespace collapses to one space. */
export function cleanLine(v: unknown, max: number): string {
  if (v == null) return "";
  return String(v)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "")
    .trim();
}

/** `v` if it is one of `allowed`, else null. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** YYYY-MM-DD (calendar-valid) or null. `""`/null clear the date. */
export function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return isYmd(s) ? s : null;
}

/** Up to `max` distinct, cleaned labels — lower-cased so "Bug" and "bug" are one tag. */
export function parseLabels(v: unknown, maxEach: number, maxCount: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const l = cleanLine(raw, maxEach).toLowerCase();
    if (l && !out.includes(l)) out.push(l);
    if (out.length >= maxCount) break;
  }
  return out;
}

/** Distinct uuids, or null when the input is not an array / holds junk. */
export function parseUuidList(v: unknown, maxCount: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const id of v) {
    if (!isUuid(id)) return null;
    const low = id.toLowerCase();
    if (!out.includes(low)) out.push(low);
    if (out.length > maxCount) return null;
  }
  return out;
}

/** Positive finite number within [min, max] (2 decimals), else null. */
export function parseNumber(v: unknown, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

/** http(s) URL (used for store links). */
export function cleanUrl(v: unknown, max = 400): string | null {
  const s = cleanLine(v, max);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Android application id: com.example.app */
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
export const isPackageId = (s: string) => PACKAGE_RE.test(s) && s.length <= 150;

/** Supabase/Postgres: unique violation. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";
/** Our own plpgsql `raise ... errcode P0002` (no_data_found): row missing. */
export const isNoData = (e: unknown) => (e as { code?: string } | null)?.code === "P0002";
