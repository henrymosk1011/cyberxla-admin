import { test } from "node:test";
import assert from "node:assert/strict";
import { blankFields, fieldLabel, DEFAULT_TEMPLATE, PLACEHOLDERS, resolveTemplate, templateDashes, unknownPlaceholders } from "./template.ts";

test("an empty template is the defaults", () => {
  assert.deepEqual(resolveTemplate({}), DEFAULT_TEMPLATE);
  assert.deepEqual(resolveTemplate(null), DEFAULT_TEMPLATE);
  assert.equal(DEFAULT_TEMPLATE.did_items.length, 9);
});

test("saved parts win, broken parts fall back", () => {
  const t = resolveTemplate({ did_items: [{ title: "A", text: "B" }], weekly: { headline: "Hi", kpi_labels: ["x"] }, pill_clear: " " });
  assert.deepEqual(t.did_items, [{ title: "A", text: "B" }]);
  assert.equal(t.weekly.headline, "Hi");
  assert.deepEqual(t.weekly.kpi_labels, DEFAULT_TEMPLATE.weekly.kpi_labels);
  assert.equal(t.pill_clear, "All clear");
  assert.equal(t.monthly.headline, DEFAULT_TEMPLATE.monthly.headline);
});

test("the defaults only use known placeholders and no dashes", () => {
  assert.deepEqual(unknownPlaceholders(DEFAULT_TEMPLATE), []);
  assert.deepEqual(templateDashes(DEFAULT_TEMPLATE), []);
  assert.ok("summary" in PLACEHOLDERS && "client" in PLACEHOLDERS);
});

test("typos in placeholders are caught", () => {
  const t = structuredClone(DEFAULT_TEMPLATE);
  t.weekly.headline = "{Patched} of {computers} ({computer})";
  assert.deepEqual(unknownPlaceholders(t).map((u) => u.name), ["{Patched}", "{computer}"]);
});

test("blank fields are listed", () => {
  const t = structuredClone(DEFAULT_TEMPLATE);
  t.security_title = "  ";
  t.monthly.kpi_labels[2] = "";
  assert.deepEqual(blankFields(t), ["security_title", "monthly.kpi_labels[2]"]);
});

test("field names in plain words", () => {
  assert.equal(fieldLabel("weekly.kpi_labels[1]"), "Weekly number label 2");
  assert.equal(fieldLabel("monthly.headline"), "Monthly headline");
  assert.equal(fieldLabel("did_items[0].text"), "What we did item 1 description");
  assert.equal(fieldLabel("security_text"), "Security text");
});
