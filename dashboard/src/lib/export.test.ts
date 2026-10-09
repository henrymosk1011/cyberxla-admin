import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTable, FIELDS, toCSV, toXLSX, zip } from "./export.ts";
import type { Lead } from "./types.ts";

const lead = (o: Partial<Lead>): Lead => ({ id: "1", created_at: "2026-10-01T17:30:00Z", updated_at: "2026-10-02T17:30:00Z", name: "Ana", company: null, email: "a@b.co", phone: null, status: "new", source: "quote_builder", value_monthly: 450, value_one_time: 0, archived_at: null, ...o });
const pick = (...keys: string[]) => FIELDS.filter((f) => keys.includes(f.key));

test("CSV quotes commas/newlines and neutralizes formulas", () => {
  const t = buildTable([lead({ name: '=HYPERLINK("http://x")', company: "Acme, Inc.\nLA" })], pick("name", "company", "value_monthly"), () => ({ notes: [] }));
  const csv = toCSV(t);
  assert.ok(csv.startsWith("﻿Name,Company,Monthly value\r\n"));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(csv.includes('"Acme, Inc.\nLA"'));
  assert.ok(csv.trimEnd().endsWith(",450"));
});

test("XLSX is a valid zip with the expected parts", () => {
  const t = buildTable([lead({}), lead({ id: "2", name: "<b>&", status: "won" })], pick("name", "status", "value_monthly", "created_at"), () => ({ notes: [] }));
  const x = toXLSX(t);
  assert.equal(new DataView(x.buffer).getUint32(0, true), 0x04034b50);
  const text = new TextDecoder().decode(x);
  for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]) assert.ok(text.includes(part), part);
  assert.ok(text.includes("&lt;b&gt;&amp;"));
  assert.ok(text.includes("<v>450</v>"));
  assert.ok(text.includes(">Won<"));
});

test("zip end record counts entries", () => {
  const z = zip([["a.txt", new Uint8Array([1, 2, 3])], ["b.txt", new Uint8Array([])]]);
  const end = new DataView(z.buffer, z.length - 22);
  assert.equal(end.getUint32(0, true), 0x06054b50);
  assert.equal(end.getUint16(10, true), 2);
});
