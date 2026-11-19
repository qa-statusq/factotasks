// Copies PDF.js's worker, CMaps, standard fonts and wasm decoders into public/pdfjs/ so the
// browser loads them from the panel's own origin (the CSP allows nothing else). Run after
// changing the pdfjs-dist version: node scripts/copy-pdfjs.mjs
import { cpSync, mkdirSync, rmSync, readFileSync } from "node:fs";
const src = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const out = new URL("../public/pdfjs/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("legacy/build/pdf.worker.min.mjs", src), new URL("pdf.worker.min.mjs", out));
for (const dir of ["cmaps", "standard_fonts", "wasm"]) cpSync(new URL(`${dir}/`, src), new URL(`${dir}/`, out), { recursive: true });
const v = JSON.parse(readFileSync(new URL("package.json", src), "utf8")).version;
console.log(`pdfjs-dist ${v} → public/pdfjs/`);
