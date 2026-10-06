// Fails if the website's prices and the submit-quote CATALOG disagree.
// Usage: node --experimental-strip-types scripts/check-catalog.mjs [path-or-url]
// Default: https://cyberx.la/build-your-quote/
import { readFile } from "node:fs/promises";
import { CATALOG } from "../supabase/functions/submit-quote/lib.ts";

const src = process.argv[2] ?? "https://cyberx.la/build-your-quote/";
const html = /^https?:/.test(src) ? await (await fetch(src)).text() : await readFile(src, "utf8");

const site = {};
const re = /<article class="svc" data-id="([^"]+)" data-price="([^"]+)" data-unit="([^"]+)"( data-from="1")?>[\s\S]*?<span class="svc-name">([^<]+)<\/span>/g;
for (const m of html.matchAll(re)) site[m[1]] = { name: m[5], price: +m[2], unit: m[3], from: !!m[4] };

const problems = [];
for (const id of new Set([...Object.keys(site), ...Object.keys(CATALOG)])) {
  const a = site[id], b = CATALOG[id];
  if (!a) problems.push(`${id}: in CATALOG but not on the website`);
  else if (!b) problems.push(`${id}: on the website but not in CATALOG`);
  else for (const k of ["name", "price", "unit"]) if (a[k] !== b[k]) problems.push(`${id}.${k}: website ${a[k]} vs CATALOG ${b[k]}`);
  if (a && b && a.from !== !!b.from) problems.push(`${id}.from differs`);
}
if (!Object.keys(site).length) problems.push("no services found on the website page");
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`OK: ${Object.keys(site).length} services match.`);
