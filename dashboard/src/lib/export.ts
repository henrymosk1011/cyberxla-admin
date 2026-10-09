// Lead exports: pick fields, get a CSV or a real .xlsx (no dependencies).
import { STATUS_LABEL } from "./format.ts";
import type { Client, Lead, Note, Quote } from "./types.ts";

export type Kind = "text" | "money" | "int" | "date";
export type Ctx = { quote?: Quote; notes: Note[]; client?: Client };
export type Field = { key: string; label: string; group: string; kind: Kind; get: (l: Lead, c: Ctx) => string | number | null; on?: boolean };

const SOURCE: Record<Lead["source"], string> = { quote_builder: "Build Your Quote", contact: "Contact form", manual: "Added manually" };

export const FIELDS: Field[] = [
  { key: "name", label: "Name", group: "Contact", kind: "text", get: (l) => l.name, on: true },
  { key: "company", label: "Company", group: "Contact", kind: "text", get: (l) => l.company, on: true },
  { key: "email", label: "Email", group: "Contact", kind: "text", get: (l) => l.email, on: true },
  { key: "phone", label: "Phone", group: "Contact", kind: "text", get: (l) => l.phone, on: true },

  { key: "status", label: "Status", group: "Pipeline", kind: "text", get: (l) => STATUS_LABEL[l.status] ?? l.status, on: true },
  { key: "value_monthly", label: "Monthly value", group: "Pipeline", kind: "money", get: (l) => l.value_monthly, on: true },
  { key: "value_one_time", label: "One-time value", group: "Pipeline", kind: "money", get: (l) => l.value_one_time, on: true },
  { key: "source", label: "Source", group: "Pipeline", kind: "text", get: (l) => SOURCE[l.source] ?? l.source },
  { key: "created_at", label: "Received", group: "Pipeline", kind: "date", get: (l) => l.created_at, on: true },
  { key: "updated_at", label: "Last activity", group: "Pipeline", kind: "date", get: (l) => l.updated_at },
  { key: "archived", label: "Archived", group: "Pipeline", kind: "text", get: (l) => (l.archived_at ? "Yes" : "No") },
  { key: "client", label: "Converted to client", group: "Pipeline", kind: "text", get: (_, c) => (c.client ? "Yes" : "No") },

  { key: "q_services", label: "Services", group: "Latest quote", kind: "text", get: (_, c) => c.quote?.items.map((i) => i.name).join(", ") ?? null, on: true },
  { key: "q_workstations", label: "Workstations", group: "Latest quote", kind: "int", get: (_, c) => c.quote?.workstations ?? null },
  { key: "q_servers", label: "Servers", group: "Latest quote", kind: "int", get: (_, c) => c.quote?.servers ?? null },
  { key: "q_monthly", label: "Quote monthly total", group: "Latest quote", kind: "money", get: (_, c) => c.quote?.monthly_total ?? null },
  { key: "q_once", label: "Quote one-time total", group: "Latest quote", kind: "money", get: (_, c) => c.quote?.one_time_total ?? null },
  { key: "q_status", label: "Quote status", group: "Latest quote", kind: "text", get: (_, c) => (c.quote ? STATUS_LABEL[c.quote.status] ?? c.quote.status : null) },
  { key: "q_date", label: "Quote date", group: "Latest quote", kind: "date", get: (_, c) => c.quote?.created_at ?? null },
  { key: "q_message", label: "Their message", group: "Latest quote", kind: "text", get: (_, c) => c.quote?.message ?? null },

  { key: "notes", label: "Notes", group: "Notes", kind: "text", get: (_, c) => c.notes.map((n) => `${localStamp(n.created_at)}: ${n.body}`).join("\n") || null },
];
export const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

/** "2026-10-09 14:03" in the viewer's time zone. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type Table = { fields: Field[]; rows: (string | number | null)[][] };

export function buildTable(leads: Lead[], fields: Field[], ctx: (l: Lead) => Ctx): Table {
  return { fields, rows: leads.map((l) => { const c = ctx(l); return fields.map((f) => f.get(l, c)); }) };
}

// ---- CSV ----------------------------------------------------------------

/** Leads come from a public form, so neutralize anything a spreadsheet would run as a formula. */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

export function toCSV(t: Table): string {
  const cell = (v: string | number | null, k: Kind) => {
    if (v === null || v === undefined) return "";
    const s = k === "date" ? localStamp(String(v)) : typeof v === "number" ? String(v) : safeText(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [t.fields.map((f) => cell(f.label, "text")), ...t.rows.map((r) => r.map((v, i) => cell(v, t.fields[i]!.kind)))];
  // BOM so Excel opens UTF-8 (accents, emoji) correctly.
  return "﻿" + lines.map((l) => l.join(",")).join("\r\n") + "\r\n";
}

// ---- XLSX ---------------------------------------------------------------

const xmlEsc = (s: string) =>
  s.replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Excel date serial in local time, so cells show the same clock time as the dashboard. */
function excelDate(iso: string): number {
  const d = new Date(iso);
  return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569;
}

// Style ids from styles.xml below.
const S = { header: 1, money: 2, date: 3, wrap: 4, int: 5 } as const;

export function toXLSX(t: Table, sheetName = "Leads"): Uint8Array {
  const widths = t.fields.map((f) => f.label.length + 2);
  const rowsXml: string[] = [];
  const head = t.fields.map((f, i) => `<c r="${colName(i)}1" t="inlineStr" s="${S.header}"><is><t>${xmlEsc(f.label)}</t></is></c>`).join("");
  rowsXml.push(`<row r="1">${head}</row>`);
  t.rows.forEach((r, ri) => {
    const n = ri + 2;
    const cells = r.map((v, i) => {
      if (v === null || v === undefined || v === "") return "";
      const ref = colName(i) + n, k = t.fields[i]!.kind;
      if (k === "date") { widths[i] = Math.max(widths[i]!, 17); return `<c r="${ref}" s="${S.date}"><v>${excelDate(String(v))}</v></c>`; }
      if ((k === "money" || k === "int") && typeof v === "number" && Number.isFinite(v)) {
        widths[i] = Math.max(widths[i]!, String(v).length + 4);
        return `<c r="${ref}" s="${k === "money" ? S.money : S.int}"><v>${v}</v></c>`;
      }
      const s = String(v);
      const longest = Math.max(...s.split("\n").map((x) => x.length));
      widths[i] = Math.min(60, Math.max(widths[i]!, longest + 2));
      // Inline strings are never evaluated as formulas.
      return `<c r="${ref}" t="inlineStr"${s.includes("\n") ? ` s="${S.wrap}"` : ""}><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
    }).join("");
    rowsXml.push(`<row r="${n}">${cells}</row>`);
  });
  const last = colName(Math.max(0, t.fields.length - 1)) + (t.rows.length + 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rowsXml.join("")}</sheetData>${t.fields.length ? `<autoFilter ref="A1:${last}"/>` : ""}</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD6FF3F"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="6"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>${t.fields.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(sheetName)}'!$A$1:$${last.replace(/\d+$/, "")}$${t.rows.length + 1}</definedName></definedNames>` : ""}</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  return zip(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// ---- Minimal ZIP (stored, no compression) -------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nb = enc.encode(name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true);
    ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), nb, data);
    centrals.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

export function download(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
