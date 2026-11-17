import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BadDoc, addonsFor, blankDoc, discountCents, docProblem, fill, longDate, newKey, normalizeDoc, resolveDoc, tierMargin, totals, usd, varsFor,
  type ProposalDoc,
} from "../supabase/functions/_shared/proposal.ts";

const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/workspace-template.json", import.meta.url), "utf8"));
const doc = (patch: Partial<ProposalDoc> = {}): ProposalDoc => normalizeDoc({ ...structuredClone(TEMPLATE), ...patch });

test("the seeded template is a valid document and survives a round trip unchanged", () => {
  const d = doc();
  assert.deepEqual(normalizeDoc(JSON.parse(JSON.stringify(d))), d);
  assert.equal(d.tiers.length, 3);
  assert.equal(d.rows.length, 19);
  assert.equal(d.default_tier, "pro");
});

test("tiers: the price of the selected tier, add ons on top", () => {
  const d = doc();
  assert.equal(totals(d, "pro", []).once_total, 550000);
  assert.equal(totals(d, "essentials", ["usb", "hyper"]).once_total, 420000 + 40000 + 50000);
  // Complete includes every add on: ticked ones don't count twice.
  const c = totals(d, "complete", ["usb", "win"]);
  assert.equal(c.once_total, 840000);
  assert.deepEqual(c.addons, []);
  assert.equal(addonsFor(d, "complete").included.length, 5);
  // Unknown tier falls back to the default.
  assert.equal(totals(d, "nope", []).tier, "pro");
});

test("add ons that are unavailable on a tier are dropped", () => {
  const d = doc();
  d.addons[0]!.tiers.essentials = "unavailable";
  assert.deepEqual(totals(d, "essentials", ["usb", "win"]).addons, ["win"]);
});

test("monthly and one time are kept apart", () => {
  const d = doc();
  d.tiers[1]!.monthly = 99.5;
  d.addons.push({ key: "mon", name: "Monitoring", description: "", price: 49, billing: "monthly", discount: null, tiers: { essentials: "available", pro: "available", complete: "available" } });
  const t = totals(d, "pro", ["mon", "usb"]);
  assert.equal(t.once_total, 550000 + 40000);
  assert.equal(t.monthly_total, 9950 + 4900);
  assert.deepEqual(t.lines.map((l) => [l.name, l.billing]), [["Pro tier", "once"], ["Pro, monthly", "monthly"], ["USB Security Keys", "once"], ["Monitoring", "monthly"]]);
});

test("item discounts: percent and amount, never below zero", () => {
  const d = doc();
  d.tiers[1]!.discount = { kind: "percent", value: 10 };
  d.addons[0]!.discount = { kind: "amount", value: 50 };
  const t = totals(d, "pro", ["usb"]);
  assert.equal(t.lines[0]!.list, 550000);
  assert.equal(t.lines[0]!.price, 495000);
  assert.equal(t.lines[1]!.price, 35000);
  assert.equal(t.once_total, 495000 + 35000);
  assert.equal(t.savings_once, 55000 + 5000);
  assert.equal(discountCents(1000, { kind: "amount", value: 50 }), 1000);
  assert.equal(discountCents(1000, { kind: "percent", value: 150 }), 1000);
});

test("whole quote discount: fixed or percent, on one time or monthly, shared over lines", () => {
  const pct = doc({ discount: { kind: "percent", value: 10, label: "Loyalty discount", applies_to: "once" } } as Partial<ProposalDoc>);
  const t = totals(pct, "essentials", ["usb"]);
  assert.equal(t.once_subtotal, 460000);
  assert.equal(t.discount_once, 46000);
  assert.equal(t.once_total, 414000);
  assert.equal(t.lines.reduce((s, l) => s + l.net, 0), 414000);

  const fixed = doc({ discount: { kind: "amount", value: 5000, label: "Discount", applies_to: "once" } } as Partial<ProposalDoc>);
  const f = totals(fixed, "essentials", ["usb"]);
  assert.equal(f.once_total, 0);
  // The tier line takes the discount first, the rest spills to the next line.
  assert.deepEqual(f.lines.map((l) => l.net), [0, 0]);

  const mo = normalizeDoc({ ...blankDoc(), tiers: [{ key: "a", name: "Plan", price: 100, monthly: 300, summary: "" }], discount: { kind: "percent", value: 50, label: "", applies_to: "monthly" } });
  const m = totals(mo, "a", []);
  assert.equal(m.monthly_total, 15000);
  assert.equal(m.once_total, 10000);
  assert.equal(mo.discount!.label, "Discount");
});

test("rounding happens once per step, in cents", () => {
  const d = normalizeDoc({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 333.33, summary: "", discount: { kind: "percent", value: 33.333 } }] });
  const t = totals(d, "a", []);
  // Percents keep 2 decimals (33.33), then 33333 * 33.33% = 11109.89 -> 11110 off.
  assert.equal(d.tiers[0]!.discount!.value, 33.33);
  assert.equal(t.lines[0]!.price, 33333 - 11110);
  assert.equal(normalizeDoc({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 10.005, summary: "" }] }).tiers[0]!.price, 10.01);
});

test("deposits: percent or amount of the one time total, or the full amount", () => {
  const d = doc({ payment: { mode: "deposit", deposit_kind: "percent", deposit_value: 50 } });
  assert.equal(totals(d, "pro", []).due_now, 275000);
  const odd = normalizeDoc({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 100.01, summary: "" }], payment: { mode: "deposit", deposit_kind: "percent", deposit_value: 50 } });
  assert.equal(totals(odd, "a", []).due_now, 5001);
  const amt = doc({ payment: { mode: "deposit", deposit_kind: "amount", deposit_value: 1000 } });
  assert.equal(totals(amt, "pro", []).due_now, 100000);
  const capped = doc({ payment: { mode: "deposit", deposit_kind: "amount", deposit_value: 99999 } });
  assert.equal(totals(capped, "pro", []).due_now, 550000);
  assert.equal(totals(doc({ payment: { mode: "full", deposit_kind: "percent", deposit_value: 0 } }), "pro", ["usb"]).due_now, 590000);
  assert.equal(totals(doc(), "pro", []).due_now, 0);
  assert.throws(() => doc({ payment: { mode: "deposit", deposit_kind: "percent", deposit_value: 0 } }), BadDoc);
});

test("a single tier quote", () => {
  const d = normalizeDoc({ ...blankDoc(), tiers: [{ key: "only", name: "Website fix", price: 999, summary: "" }], rows: [{ key: "r1", label: "Audit", explain: "", values: { only: true } }] });
  assert.equal(d.tiers.length, 1);
  assert.equal(totals(d, "only", []).once_total, 99900);
  assert.equal(totals(d, "only", []).lines[0]!.name, "Website fix");
});

test("validation: limits, keys, and unknown fields", () => {
  assert.match(docProblem({ ...blankDoc(), tiers: [] })!, /Tiers needs at least 1/);
  assert.match(docProblem({ ...blankDoc(), tiers: Array.from({ length: 7 }, (_, i) => ({ key: `t${i}`, name: "T", price: 1 })) })!, /at most 6/);
  assert.match(docProblem({ ...blankDoc(), tiers: [{ key: "Bad Key", name: "A", price: 1 }] })!, /bad key/);
  assert.match(docProblem({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: -1 }] })!, /price/);
  assert.match(docProblem({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 1, summary: "x".repeat(241) }] })!, /longer/);
  assert.match(docProblem({ ...blankDoc(), tiers: [{ key: "a", name: "A\nB", price: 1 }] })!, /characters/);
  assert.match(docProblem({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 1 }, { key: "a", name: "B", price: 1 }] })!, /repeats/);
  // Unknown fields (like an internal cost typed into the wrong place) are dropped, never published.
  const d = normalizeDoc({ ...blankDoc(), secret: "x", tiers: [{ key: "a", name: "A", price: 1, cost: 500 }] });
  assert.equal("secret" in d, false);
  assert.equal("cost" in d.tiers[0]!, false);
  // Rows get a value for every tier; text means included.
  const r = normalizeDoc({ ...blankDoc(), tiers: [{ key: "a", name: "A", price: 1 }, { key: "b", name: "B", price: 2 }], rows: [{ key: "r", label: "R", values: { a: "1 week", zz: true } }] });
  assert.deepEqual(r.rows[0]!.values, { a: "1 week", b: false });
});

test("placeholders fill everywhere a client reads", () => {
  const vars = varsFor({ number: 1001, company: "Acme Dental", contact_name: "Jane Q Doe", valid_until: "2026-12-17" });
  assert.deepEqual(vars, { company: "Acme Dental", contact_first_name: "Jane", quote_number: "Q1001", valid_until: "December 17, 2026" });
  assert.equal(fill("Hi {contact_first_name}, {quote_number} for {company} is good until {valid_until}. {other}", vars), "Hi Jane, Q1001 for Acme Dental is good until December 17, 2026. {other}");
  const r = resolveDoc(doc(), vars);
  assert.match(r.rows[0]!.explain, /license Acme Dental pays/);
  assert.equal(varsFor({ number: 5, company: null, contact_name: null, valid_until: "2026-01-02" }).contact_first_name, "there");
});

test("formatting", () => {
  assert.equal(usd(420000), "$4,200");
  assert.equal(usd(420050), "$4,200.50");
  assert.equal(usd(5), "$0.05");
  assert.equal(longDate("2026-11-17"), "November 17, 2026");
});

test("margin per tier from internal costs", () => {
  const d = doc();
  const m = tierMargin(d, { costs: { "tier:pro": 1000, "row:email": 200, "row:vault": 999 } }, "pro");
  assert.equal(m.cost, 120000);
  assert.equal(m.margin, 550000 - 120000);
  assert.equal(tierMargin(d, {}, "complete").cost, 0);
});

test("new keys are unique", () => {
  let i = 0;
  const seq = [0.1, 0.1, 0.2];
  const k1 = newKey([], () => seq[i++]!);
  const k2 = newKey([k1], () => seq[i++]!);
  assert.notEqual(k1, k2);
  assert.match(k1, /^k[0-9a-z]{6}$/);
});
