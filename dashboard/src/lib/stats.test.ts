import { test } from "node:test";
import assert from "node:assert/strict";
import { kpis, stages, ticks, topServices, weekly, weekStart } from "./stats.ts";
import type { Lead, Quote } from "./types.ts";

const NOW = new Date("2026-10-07T12:00:00"); // a Wednesday
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

const lead = (id: string, status: Lead["status"], created: number, updated = created, m = 300, o = 0): Lead => ({
  id, status, created_at: daysAgo(created), updated_at: daysAgo(updated), name: id, company: null, email: `${id}@x.co`,
  phone: null, source: "quote_builder", value_monthly: m, value_one_time: o,
});
const quote = (leadId: string, created: number, m: number, ids: string[] = ["edr"]): Quote => ({
  id: leadId + created, lead_id: leadId, created_at: daysAgo(created), updated_at: daysAgo(created), status: "submitted",
  workstations: 10, servers: 0, monthly_total: m, one_time_total: 0, monthly_minimum_applied: false, message: null,
  items: ids.map((id) => ({ id, name: id.toUpperCase(), unit: "dev", unit_price: 1, from: false, kind: "monthly", cost: 1 })),
});

test("weekStart is Monday", () => {
  assert.equal(weekStart(NOW).getDay(), 1);
  assert.equal(weekStart(NOW).getDate(), 5);
});

test("kpis count the range and the prior range separately", () => {
  const leads = [lead("a", "new", 1), lead("b", "contacted", 10), lead("c", "won", 40, 3, 500), lead("d", "lost", 50, 5), lead("e", "proposal", 200)];
  const k = kpis(leads, [quote("a", 1, 300), quote("b", 10, 600), quote("c", 40, 500)], 4, NOW);
  assert.equal(k.newLeads, 2);
  assert.equal(k.newLeadsPrev, 2);
  assert.equal(k.quotes, 2);
  assert.equal(k.openCount, 3);
  assert.equal(k.openMonthly, 900);
  assert.equal(k.wonMonthly, 500);
  assert.equal(k.winRate, 0.5);
  assert.equal(k.avgMonthly, 450);
});

test("win rate is null with nothing closed", () => {
  assert.equal(kpis([lead("a", "new", 1)], [], 4, NOW).winRate, null);
});

test("weekly always returns N buckets, oldest first, current week last", () => {
  const w = weekly([quote("a", 0, 300), quote("b", 1, 100), quote("c", 8, 50), quote("d", 400, 1)], 12, NOW);
  assert.equal(w.length, 12);
  assert.ok(w[0]!.start < w[11]!.start);
  assert.equal(w[11]!.count, 2);
  assert.equal(w[11]!.monthly, 400);
  assert.equal(w[10]!.count, 1);
  assert.equal(w.reduce((s, b) => s + b.count, 0), 3);
});

test("stages cover every status in pipeline order", () => {
  const s = stages([lead("a", "won", 1), lead("b", "won", 1, 1, 200)]);
  assert.deepEqual(s.map((x) => x.status), ["new", "contacted", "proposal", "won", "lost"]);
  assert.equal(s[3]!.count, 2);
  assert.equal(s[3]!.monthly, 500);
});

test("topServices ranks by count with share of quotes", () => {
  const t = topServices([quote("a", 1, 1, ["edr", "mdr"]), quote("b", 2, 1, ["edr"]), quote("c", 400, 1, ["mdr"])], 4, 8, NOW);
  assert.deepEqual(t.map((x) => [x.id, x.count, x.share]), [["edr", 2, 1], ["mdr", 1, 0.5]]);
});

test("ticks are clean and cover the max", () => {
  assert.deepEqual(ticks(7, 4, true), [0, 2, 4, 6, 8]);
  assert.deepEqual(ticks(3, 4, true), [0, 1, 2, 3]);
  assert.deepEqual(ticks(0), [0, 1]);
  assert.deepEqual(ticks(4800), [0, 2000, 4000, 6000]);
});
