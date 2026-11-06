// The report template in the dashboard: the defaults (a copy of the reports
// repo's lib/template.js, exported by its scripts/export-template.js), filling
// gaps the same way generate does, and checks for typos in placeholders.
import defaults from "./report-template.default.json" with { type: "json" };
import { hasDash, strings } from "./reports.ts";
import type { ReportTemplate, ReportTemplatePeriod } from "./types.ts";

export const DEFAULT_TEMPLATE = defaults.template as ReportTemplate;
/** {name} -> what it becomes. */
export const PLACEHOLDERS: Record<string, string> = defaults.placeholders;

const text = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
const texts = (v: unknown, d: string[]) =>
  Array.isArray(v) && v.length === d.length && v.every((x) => typeof x === "string" && x.trim()) ? [...(v as string[])] : [...d];
const items = (v: unknown, d: ReportTemplate["did_items"]) =>
  Array.isArray(v) && v.every((i) => i && typeof i.title === "string" && typeof i.text === "string")
    ? (v as ReportTemplate["did_items"]).map((i) => ({ title: i.title, text: i.text }))
    : d.map((i) => ({ ...i }));

function period(t: unknown, d: ReportTemplatePeriod): ReportTemplatePeriod {
  const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(d)) out[k] = Array.isArray(def) ? texts(o[k], def) : text(o[k], def as string);
  return out as ReportTemplatePeriod;
}

/** A saved template with every gap filled from the defaults (the same rules as generate). */
export function resolveTemplate(t: unknown): ReportTemplate {
  const o = (t && typeof t === "object" && !Array.isArray(t) ? t : {}) as Record<string, unknown>;
  const d = DEFAULT_TEMPLATE as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { v: 1, did_items: items(o.did_items, DEFAULT_TEMPLATE.did_items) };
  for (const [k, def] of Object.entries(d)) if (typeof def === "string") out[k] = text(o[k], def);
  out.weekly = period(o.weekly, DEFAULT_TEMPLATE.weekly);
  out.monthly = period(o.monthly, DEFAULT_TEMPLATE.monthly);
  return out as ReportTemplate;
}

/** {Something} written in a field that isn't a known placeholder, with where it is. */
export function unknownPlaceholders(value: unknown): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const [path, s] of strings(value)) {
    for (const m of s.matchAll(/\{([^{}]{1,40})\}/g)) if (!Object.hasOwn(PLACEHOLDERS, m[1]!)) out.push({ path, name: m[0] });
  }
  return out;
}

/** Fields with a dash used as punctuation. */
export const templateDashes = (t: ReportTemplate) => strings(t).filter(([, s]) => hasDash(s)).map(([p]) => p);

/** Fields that would be blank (generate would quietly use the default instead). */
export function blankFields(t: ReportTemplate): string[] {
  return strings({ ...t, did_items: undefined }).filter(([, s]) => !s.trim()).map(([p]) => p);
}

const NAMES: Record<string, string> = {
  label: "label", subtitle: "subtitle", headline: "headline", kpi_labels: "number label", did_title: "What we did title",
  columns: "column heading", updates_title: "updates section title", subject: "email subject", body: "email body", weeks_title: "chart title",
  pill_clear: "all clear pill", pill_attention: "needs attention pill", computers_title: "computers table title",
  updates_empty_ok: "nothing to install text", updates_empty_failed: "patch run didn't finish text", security_title: "security section title",
  security_text: "security text", apps_intro: "text before the app list", security_note: "security closing note",
  next_label: "next patch window label", next_when: "next patch window time", next_note: "next patch window note",
};

/** A field path in plain words: weekly.kpi_labels[1] is "Weekly number label 2". */
export function fieldLabel(path: string): string {
  const per = /^(weekly|monthly)\.(\w+)(?:\[(\d+)\])?$/.exec(path);
  if (per) return `${per[1] === "weekly" ? "Weekly" : "Monthly"} ${NAMES[per[2]!] ?? per[2]}${per[3] ? ` ${Number(per[3]) + 1}` : ""}`;
  const did = /^did_items\[(\d+)\]\.(title|text)$/.exec(path);
  if (did) return `What we did item ${Number(did[1]) + 1} ${did[2] === "title" ? "title" : "description"}`;
  return (NAMES[path] ?? path).replace(/^./, (c) => c.toUpperCase());
}
