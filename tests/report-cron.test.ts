import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequest, dispatchRequest, jobWorkflow, parseJob, sameHex, sha256Hex, tokenMatches } from "../supabase/functions/report-cron/lib.ts";

const rejects = (body: unknown, field: string) => assert.throws(() => parseJob(body), (e) => e instanceof BadRequest && e.message === field);

test("accepts the three jobs", () => {
  assert.equal(parseJob({ job: "generate" }), "generate");
  assert.equal(parseJob({ job: "send" }), "send");
  assert.equal(parseJob({ job: "unifi" }), "unifi");
});

test("rejects anything else", () => {
  rejects(null, "body");
  rejects([], "body");
  rejects({ job: "send", report_id: "x" }, "body");
  rejects({ job: "render" }, "job");
  rejects({ job: "SEND" }, "job");
  rejects({}, "job");
});

test("generate acts like the Sunday schedule; send and unifi cover everything", () => {
  assert.deepEqual(jobWorkflow("generate"), { workflow: "generate.yml", inputs: { scheduled: "true" } });
  assert.deepEqual(jobWorkflow("send"), { workflow: "send.yml", inputs: {} });
  assert.deepEqual(jobWorkflow("unifi"), { workflow: "unifi-check.yml", inputs: {} });
});

test("dispatches on main for the reports repo", () => {
  const { url, init } = dispatchRequest("henrymosk1011/cyberxla-patch-reports", "send", "tok");
  assert.equal(url, "https://api.github.com/repos/henrymosk1011/cyberxla-patch-reports/actions/workflows/send.yml/dispatches");
  assert.deepEqual(JSON.parse(init.body), { ref: "main", inputs: {} });
  assert.equal(init.headers.Authorization, "Bearer tok");
  assert.throws(() => dispatchRequest("not a repo", "send", "tok"));
});

test("the token must hash to the stored hash", async () => {
  const token = "a".repeat(64);
  const hash = await sha256Hex(token);
  assert.equal(hash.length, 64);
  assert.equal(await tokenMatches(token, hash), true);
  assert.equal(await tokenMatches(token, ` ${hash.toUpperCase()}\n`), true);
  assert.equal(await tokenMatches("b".repeat(64), hash), false);
  assert.equal(await tokenMatches("", hash), false);
  assert.equal(await tokenMatches(token, ""), false);
  assert.equal(await tokenMatches(hash, hash), false);
  assert.equal(sameHex(hash, hash.slice(0, 63)), false);
});
