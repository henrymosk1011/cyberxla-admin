import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentProblem, countdown, dashFields, groupBySend, hasDash, parseEmails, recalcKpis, reportActions, reportState, sendNowText, thisWeek } from "./reports.ts";
import type { ReportContent, ReportRow } from "./types.ts";

// Made up content from the reports repo's generator (see the file's _note).
const FIX = JSON.parse(readFileSync(new URL("../../../tests/fixtures/report-content.json", import.meta.url), "utf8"));
const weekly = FIX.weekly.content as ReportContent;
const monthly = FIX.monthly.content as ReportContent;

const NOW = Date.parse("2026-11-09T12:00:00Z");
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();
const row = (over: Partial<ReportRow> = {}) =>
  ({ status: "scheduled", send_at: at(240), sent_at: null, claimed_at: null, error: null, is_test: false, ...over }) as ReportRow;

test("countdown", () => {
  assert.equal(countdown(at(-1), NOW), "now");
  assert.equal(countdown(at(5), NOW), "in 5 min");
  assert.equal(countdown(at(192), NOW), "in 3h 12m");
  assert.equal(countdown(at(60 * 52), NOW), "in 2d 4h");
});

test("status in words, including late, missed and stuck", () => {
  assert.equal(reportState(row(), NOW).label, "Scheduled");
  assert.match(reportState(row(), NOW).note, /^Sends in 4h 0m/);
  assert.equal(reportState(row({ send_at: at(-30) }), NOW).label, "Scheduled");
  assert.equal(reportState(row({ send_at: at(-120) }), NOW).label, "Late");
  assert.equal(reportState(row({ send_at: at(-60 * 25) }), NOW).label, "Missed");
  assert.equal(reportState(row({ status: "held" }), NOW).label, "On hold");
  assert.equal(reportState(row({ status: "sending", claimed_at: at(-2) }), NOW).tone, "info");
  assert.match(reportState(row({ status: "sending", claimed_at: at(-40) }), NOW).note, /Check Sent Items/);
  assert.equal(reportState(row({ status: "failed", error: "Graph sendMail failed: HTTP 403" }), NOW).note, "Graph sendMail failed: HTTP 403");
  assert.match(reportState(row({ is_test: true }), NOW).note, /never send on a schedule/);
});

test("buttons follow the status", () => {
  const s = reportActions(row(), NOW);
  assert.deepEqual([s.hold, s.resume, s.sendNow, s.edit, s.remove], [true, false, true, true, true]);
  const held = reportActions(row({ status: "held" }), NOW);
  assert.deepEqual([held.hold, held.resume, held.sendNow], [false, true, true]);
  // Held past the send window: resuming would never send, so only Send now.
  const late = reportActions(row({ status: "held", send_at: at(-60 * 30) }), NOW);
  assert.deepEqual([late.resume, late.sendNow], [false, true]);
  const sending = reportActions(row({ status: "sending" }), NOW);
  assert.deepEqual([sending.edit, sending.sendNow, sending.markSent, sending.markNotSent, sending.remove], [false, false, true, true, false]);
  const sent = reportActions(row({ status: "sent" }), NOW);
  assert.deepEqual([sent.edit, sent.sendNow, sent.remove], [false, false, false]);
  assert.equal(reportActions(row({ status: "sent", is_test: true }), NOW).remove, true);
});

test("Hold all and Resume all only touch this week's real reports", () => {
  const rows = [
    row({ id: "a", status: "scheduled" }), row({ id: "b", status: "held" }), row({ id: "c", status: "held", is_test: true }),
    row({ id: "d", status: "scheduled", send_at: at(-60 * 48) }), row({ id: "e", status: "held", send_at: at(-30) }), row({ id: "f", status: "sent" }),
  ];
  const w = thisWeek(rows, NOW);
  assert.deepEqual(w.toHold.map((r) => r.id), ["a"]);
  assert.deepEqual(w.toResume.map((r) => r.id), ["b"]);
});

test("groups by send day with tests on their own", () => {
  const rows = [
    row({ client_name: "B", period: "weekly", send_at: "2026-11-09T16:00:00Z" }),
    row({ client_name: "A", period: "monthly", send_at: "2026-11-09T16:00:00Z" }),
    row({ client_name: "A", period: "weekly", send_at: "2026-11-09T16:00:00Z" }),
    row({ client_name: "A", period: "weekly", send_at: "2026-11-02T16:00:00Z" }),
    row({ client_name: "A", period: "weekly", send_at: "2026-11-09T16:00:00Z", is_test: true }),
  ];
  const g = groupBySend(rows);
  assert.equal(g.length, 3);
  assert.deepEqual(g[0]!.rows.map((r) => `${r.client_name} ${r.period}`), ["A weekly", "A monthly", "B weekly"]);
  assert.equal(g[2]!.label, "Test reports");
});

test("recipients are checked like the database checks them", () => {
  assert.deepEqual(parseEmails(" Office@Example.com, owner@example.com;office@example.com\nbad@ x@y"), {
    emails: ["office@example.com", "owner@example.com"],
    invalid: ["bad@", "x@y"],
  });
});

test("Recalculate KPIs matches what the generator computed", () => {
  assert.deepEqual(recalcKpis(weekly).kpis.map((k) => k.value), weekly.kpis.map((k) => k.value));
  assert.deepEqual(recalcKpis(monthly).kpis.map((k) => k.value), monthly.kpis.map((k) => k.value));
  assert.deepEqual(recalcKpis(weekly).pill, weekly.pill);
  assert.equal(weekly.kpis[0]!.value, String(FIX.weekly.kpi.n));
  assert.equal(monthly.kpis[1]!.value, `${FIX.monthly.kpi.perfect}/${FIX.monthly.kpi.n}`);
});

test("Recalculate KPIs after hiding computers", () => {
  const c = structuredClone(weekly);
  for (const r of c.computers.list) if (r.tone !== "good") r.hidden = true;
  const out = recalcKpis(c);
  assert.deepEqual(out.kpis.map((k) => k.value), ["5", "5/5", String(c.computers.list.filter((r) => !r.hidden).reduce((s, r) => s + r.updates.count, 0)), "0"]);
  assert.deepEqual(out.pill, { text: "All clear", tone: "lime" });
  assert.equal(out.kpis[0]!.label, weekly.kpis[0]!.label);
});

test("content checks match the renderer's", () => {
  assert.equal(contentProblem(weekly), null);
  assert.equal(contentProblem(monthly), null);
  assert.match(contentProblem({ ...weekly, kpis: [{ value: 3, label: "x" }] })!, /kpis\[0\]/);
  assert.match(contentProblem({ ...weekly, pill: { text: "x", tone: "red" } })!, /pill\.tone/);
  assert.match(contentProblem([])!, /object/);
  assert.match(contentProblem({ ...weekly, v: 2 })!, /v must be 1/);
});

test("dash check", () => {
  assert.deepEqual(dashFields({ content: weekly, email: FIX.weekly.email }), []);
  const c = structuredClone(weekly);
  c.headline = "All good \u2014 nothing to do";
  c.computers.list[0]!.name = "Front Desk - Spare";
  assert.deepEqual(dashFields(c), ["headline", "computers.list[0].name"]);
  assert.equal(hasDash("x64-based KB5046617 CVE-2026-10001"), false);
});

test("Send now says where it goes", () => {
  const r = { is_test: false, recipients: ["office@example.com"], cc: ["owner@example.com"] };
  assert.match(sendNowText(r, "live"), /^Live: it goes to office@example\.com \(cc owner@example\.com\) right now/);
  assert.match(sendNowText(r, "preview"), /^Preview mode: it goes to you only, tagged for office@example\.com/);
  assert.match(sendNowText({ ...r, is_test: true }, "live"), /^This is a test report, so it goes to you only/);
});
