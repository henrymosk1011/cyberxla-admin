import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAction, workflowFor, dispatchRequest, publishableKey, BadRequest, ACTIONS } from "../supabase/functions/audit-action/lib.ts";

const UUID = "11111111-1111-1111-1111-111111111111";

test("parseAction accepts the per-audit actions with a uuid", () => {
  for (const action of ACTIONS.filter((a) => a !== "scan_pending")) {
    assert.deepEqual(parseAction({ action, audit_id: UUID }), { action, auditId: UUID });
  }
  assert.deepEqual(parseAction({ action: "scan", audit_id: UUID.toUpperCase() }).auditId, UUID);
});

test("parseAction: scan_pending (the drain) takes no audit_id", () => {
  assert.deepEqual(parseAction({ action: "scan_pending" }), { action: "scan_pending", auditId: "" });
  // an id on a drain is a mistake, not silently ignored
  assert.throws(() => parseAction({ action: "scan_pending", audit_id: UUID }), BadRequest);
});

test("parseAction rejects junk", () => {
  for (const bad of [null, [], "x", { action: "nope", audit_id: UUID }, { action: "scan" }, { action: "scan", audit_id: "no" }, { action: "scan", audit_id: UUID, extra: 1 }]) {
    assert.throws(() => parseAction(bad), BadRequest);
  }
});

test("workflowFor maps actions to workflows (cancel is database only)", () => {
  assert.equal(workflowFor("scan"), "audit-scan.yml");
  assert.equal(workflowFor("rescan"), "audit-scan.yml");
  assert.equal(workflowFor("rebuild"), "audit-render.yml");
  assert.equal(workflowFor("send_now"), "audit-send.yml");
  assert.equal(workflowFor("copy"), "audit-send.yml");
  assert.equal(workflowFor("cancel"), null);
});

test("dispatchRequest builds a valid GitHub workflow dispatch", () => {
  const { url, init } = dispatchRequest("acme/audits", "audit-scan.yml", UUID, "tok");
  assert.equal(url, "https://api.github.com/repos/acme/audits/actions/workflows/audit-scan.yml/dispatches");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body as string), { ref: "main", inputs: { audit_id: UUID } });
  assert.match((init.headers as Record<string, string>).Authorization, /^Bearer tok$/);
});

test("dispatchRequest with a null id drains (no audit_id input)", () => {
  assert.deepEqual(JSON.parse(dispatchRequest("a/b", "audit-scan.yml", null, "t").init.body as string), { ref: "main", inputs: {} });
});

test("dispatchRequest passes force for render and copy for send", () => {
  assert.deepEqual(JSON.parse(dispatchRequest("a/b", "audit-render.yml", UUID, "t", true).init.body as string).inputs, { audit_id: UUID, force: "true" });
  assert.deepEqual(JSON.parse(dispatchRequest("a/b", "audit-send.yml", UUID, "t", false, true).init.body as string).inputs, { audit_id: UUID, copy: "true" });
});

test("dispatchRequest rejects a bad repo", () => {
  assert.throws(() => dispatchRequest("not-a-repo", "audit-scan.yml", UUID, "t"), /AUDIT_REPO/);
});

test("publishableKey prefers the explicit secret, then the list, then the legacy key", () => {
  assert.equal(publishableKey((k) => (k === "PUBLISHABLE_KEY" ? "pk_explicit" : undefined)), "pk_explicit");
  assert.equal(publishableKey((k) => (k === "SUPABASE_PUBLISHABLE_KEYS" ? JSON.stringify({ default: "pk_list" }) : undefined)), "pk_list");
  assert.equal(publishableKey((k) => (k === "SUPABASE_ANON_KEY" ? "anon" : undefined)), "anon");
  assert.throws(() => publishableKey(() => undefined), /missing publishable key/);
});
