import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequest, dispatchRequest, parseAction, publishableKey, refusal, renderIsCurrent, type ReportState } from "../supabase/functions/report-action/lib.ts";

const ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const rejects = (body: unknown, field: string) => assert.throws(() => parseAction(body), (e) => e instanceof BadRequest && e.message === field);

test("accepts render, rebuild and send_now for a report id", () => {
  assert.deepEqual(parseAction({ action: "render", report_id: ID }), { action: "render", reportId: ID });
  assert.deepEqual(parseAction({ action: "rebuild", report_id: ID }), { action: "rebuild", reportId: ID });
  assert.deepEqual(parseAction({ action: "send_now", report_id: ID.toUpperCase() }), { action: "send_now", reportId: ID });
});

test("rejects anything else", () => {
  rejects(null, "body");
  rejects([], "body");
  rejects({ action: "render", report_id: ID, extra: 1 }, "body");
  rejects({ action: "delete", report_id: ID }, "action");
  rejects({ action: "send_now", report_id: "1; drop table reports" }, "report_id");
  rejects({ action: "send_now", report_id: `${ID}&status=eq.sent` }, "report_id");
  rejects({ action: "send_now" }, "report_id");
});

const r = (status: ReportState["status"], cv = 2, rv = 2): ReportState => ({ id: ID, status, content_version: cv, rendered_version: rv });

test("refuses reports that are sending or sent", () => {
  assert.match(refusal(r("sending"))!, /already sending/);
  assert.match(refusal(r("sent"))!, /already sent/);
  for (const s of ["scheduled", "held", "failed", "cancelled"] as const) assert.equal(refusal(r(s)), null);
});

test("render only when the PDFs are behind the edits", () => {
  assert.equal(renderIsCurrent(r("held", 3, 3)), true);
  assert.equal(renderIsCurrent(r("held", 4, 3)), false);
});

test("starts one workflow on main with only the report id", () => {
  const { url, init } = dispatchRequest("acme/reports", "send.yml", ID, "tok");
  assert.equal(url, "https://api.github.com/repos/acme/reports/actions/workflows/send.yml/dispatches");
  assert.deepEqual(JSON.parse(init.body), { ref: "main", inputs: { report_id: ID } });
  assert.equal(init.headers.Authorization, "Bearer tok");
  assert.throws(() => dispatchRequest("not a repo", "send.yml", ID, "tok"), /owner\/name/);
  assert.throws(() => dispatchRequest("a/b", "render.yml", "nope", "tok"), /report id/);
});

test("finds the public key under any of its names", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assert.equal(publishableKey(env({ PUBLISHABLE_KEY: "sb_publishable_x", SUPABASE_ANON_KEY: "legacy" })), "sb_publishable_x");
  assert.equal(publishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_y"}' })), "sb_publishable_y");
  assert.equal(publishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: "not json", SUPABASE_ANON_KEY: "legacy" })), "legacy");
  assert.throws(() => publishableKey(env({})), /PUBLISHABLE_KEY/);
});

test("Rebuild asks render.yml to build even when up to date; nothing else gets force", () => {
  const forced = dispatchRequest("acme/reports", "render.yml", ID, "tok", true);
  assert.deepEqual(JSON.parse(forced.init.body), { ref: "main", inputs: { report_id: ID, force: "true" } });
  assert.deepEqual(JSON.parse(dispatchRequest("acme/reports", "render.yml", ID, "tok").init.body).inputs, { report_id: ID });
  assert.deepEqual(JSON.parse(dispatchRequest("acme/reports", "send.yml", ID, "tok", true).init.body).inputs, { report_id: ID });
});
