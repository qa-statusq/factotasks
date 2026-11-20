"use client";

import { unzipSync, strFromU8 } from "fflate";

/**
 * Spreadsheets for the file viewer, read in the browser — shown as a grid
 * with sheet tabs, the way Excel shows them (not as pages).
 *
 *   - .xlsx: a zip of XML parts. The workbook names the sheets; each sheet
 *     lists its cells (A1-style refs); text lives in the shared-strings table;
 *     the styles part says which numbers are dates, percentages or fixed
 *     decimals. Formula cells show their saved result. Merged areas show
 *     their value in the top-left cell.
 *   - .csv: RFC 4180 (quoted fields, "" escapes, line breaks inside quotes),
 *     the separator guessed from the first lines (comma, semicolon or tab).
 *
 * Big sheets are capped (MAX_ROWS × MAX_COLS) so a huge export can't freeze
 * a phone; the viewer says so and offers the download for the rest.
 */
export interface Sheet {
  name: string;
  /** Display text per cell, row by row (ragged rows padded by the viewer). */
  rows: string[][];
  /** Cells that hold numbers (right-aligned, like Excel). Key `r:c`. */
  numeric: Set<string>;
  /** Column widths in characters, where the file says. */
  widths: number[];
  cols: number;
  /** The sheet had more than was kept. */
  truncated: boolean;
}

export const MAX_ROWS = 20_000;
export const MAX_COLS = 200;

/* --------------------------------- CSV ---------------------------------- */

export function parseCsv(text: string): Sheet {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  const head = src.slice(0, 4096);
  const count = (ch: string) => head.split("\n").slice(0, 5).reduce((n, l) => n + l.split(ch).length - 1, 0);
  const sep = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= MAX_ROWS) {
        truncated = i < src.length - 1;
        break;
      }
    } else field += c;
  }
  if (!truncated && (field !== "" || row.length)) {
    row.push(field);
    rows.push(row);
  }
  const numeric = new Set<string>();
  let cols = 0;
  rows.forEach((r, ri) => {
    if (r.length > MAX_COLS) {
      r.length = MAX_COLS;
      truncated = true;
    }
    cols = Math.max(cols, r.length);
    r.forEach((v, ci) => {
      if (v !== "" && /^-?[\d,]*\.?\d+(e[+-]?\d+)?%?$/i.test(v.trim())) numeric.add(`${ri}:${ci}`);
    });
  });
  return { name: "Sheet1", rows, numeric, widths: [], cols, truncated };
}

/* --------------------------------- XLSX --------------------------------- */

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_FMT: Record<number, string> = { 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00" };

const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
/** Elements by local name, whatever namespace prefix the file uses. */
const all = (n: Document | Element, name: string) => Array.from(n.getElementsByTagNameNS("*", name));
const first = (n: Document | Element, name: string) => n.getElementsByTagNameNS("*", name)[0] ?? null;

/** "BC12" → [11, 54] (0-based row, col). */
function ref(r: string): [number, number] {
  let col = 0;
  let i = 0;
  for (; i < r.length; i++) {
    const c = r.charCodeAt(i);
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
  }
  return [Number(r.slice(i)) - 1, col - 1];
}

/** Excel serial date → "20 Nov 2026" / "20 Nov 2026, 14:30" (1900 system; 1904 when the workbook says). */
function excelDate(serial: number, date1904: boolean, withTime: boolean, timeOnly: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const t = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (timeOnly) return t;
  const day = `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime && (d.getUTCHours() || d.getUTCMinutes()) ? `${day}, ${t}` : day;
}

function formatNumber(v: number, fmt: string | undefined): string {
  if (!fmt || fmt === "General") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  const pct = fmt.includes("%");
  const dec = (fmt.split(".")[1] ?? "").replace(/[^0#]/g, "").length;
  const grouped = fmt.includes(",");
  const n = pct ? v * 100 : v;
  const s = n.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouped });
  return pct ? `${s}%` : s;
}

export function parseXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && (f.name.endsWith(".xml") || f.name.endsWith(".rels")) });
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : null);
  const wbXml = read("xl/workbook.xml");
  if (!wbXml) throw new Error("Not a spreadsheet");
  const wb = xml(wbXml);
  const date1904 = first(wb, "workbookPr")?.getAttribute("date1904") === "1" || first(wb, "workbookPr")?.getAttribute("date1904") === "true";
  // Sheet name → its part, via the workbook's relationships.
  const rels = new Map<string, string>();
  const relXml = read("xl/_rels/workbook.xml.rels");
  if (relXml) for (const r of all(xml(relXml), "Relationship")) rels.set(r.getAttribute("Id") ?? "", (r.getAttribute("Target") ?? "").replace(/^\/?xl\//, "").replace(/^\//, ""));
  // Shared strings (rich text runs joined).
  const strings: string[] = [];
  const ssXml = read("xl/sharedStrings.xml");
  if (ssXml) for (const si of all(xml(ssXml), "si")) strings.push(all(si, "t").map((t) => t.textContent ?? "").join(""));
  // Styles: which cells are dates / percentages / decimals.
  const fmtOf: (string | undefined)[] = [];
  const isDate: boolean[] = [];
  const stXml = read("xl/styles.xml");
  if (stXml) {
    const st = xml(stXml);
    const custom = new Map<number, string>();
    for (const f of all(st, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? "");
    const xfs = first(st, "cellXfs");
    if (xfs)
      for (const xf of all(xfs, "xf")) {
        const id = Number(xf.getAttribute("numFmtId") ?? 0);
        const code = custom.get(id) ?? BUILTIN_FMT[id];
        // A custom format is a date when it has d / m / y / h outside quotes and brackets.
        const bare = (code ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
        fmtOf.push(code);
        isDate.push(BUILTIN_DATE.has(id) || (!!code && /[dmyh]/i.test(bare) && !/^[#0.,%E+-]+$/.test(bare)));
      }
  }
  const out: Sheet[] = [];
  for (const s of all(wb, "sheet")) {
    const name = s.getAttribute("name") ?? `Sheet${out.length + 1}`;
    const rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? s.getAttribute("r:id") ?? "";
    const part = rels.get(rid) ?? `worksheets/sheet${out.length + 1}.xml`;
    const sx = read(`xl/${part}`);
    if (!sx) continue;
    const doc = xml(sx);
    const rows: string[][] = [];
    const numeric = new Set<string>();
    let cols = 0;
    let truncated = false;
    for (const c of all(doc, "c")) {
      const r = c.getAttribute("r");
      if (!r) continue;
      const [ri, ci] = ref(r);
      if (ri >= MAX_ROWS || ci >= MAX_COLS) {
        truncated = true;
        continue;
      }
      const t = c.getAttribute("t");
      const v = first(c, "v")?.textContent ?? "";
      let text = "";
      if (t === "s") text = strings[Number(v)] ?? "";
      else if (t === "inlineStr") text = all(c, "t").map((x) => x.textContent ?? "").join("");
      else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (t === "str" || t === "e") text = v;
      else if (v !== "") {
        const n = Number(v);
        const style = Number(c.getAttribute("s") ?? 0);
        if (Number.isFinite(n) && isDate[style]) {
          const code = (fmtOf[style] ?? "").toLowerCase();
          const timeOnly = /h/.test(code) && !/[dy]/.test(code.replace(/"[^"]*"/g, ""));
          text = excelDate(n, date1904, /h/.test(code), timeOnly);
        } else if (Number.isFinite(n)) {
          text = formatNumber(n, fmtOf[style]);
          numeric.add(`${ri}:${ci}`);
        } else text = v;
      }
      if (text === "") continue;
      while (rows.length <= ri) rows.push([]);
      const row = rows[ri];
      while (row.length <= ci) row.push("");
      row[ci] = text;
      cols = Math.max(cols, ci + 1);
    }
    const widths: number[] = [];
    for (const col of all(doc, "col")) {
      const min = Number(col.getAttribute("min")), max = Math.min(Number(col.getAttribute("max")), MAX_COLS);
      const w = Number(col.getAttribute("width"));
      if (w > 0) for (let i = min; i <= max; i++) widths[i - 1] = w;
    }
    out.push({ name, rows, numeric, widths, cols, truncated });
  }
  if (!out.length) throw new Error("No sheets");
  return out;
}
