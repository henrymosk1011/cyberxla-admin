import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCredential, describeProject } from "./activity.ts";
import { totalsBy, valueLabel } from "./lines.ts";
import { ownerOptions, ownerValue, parseOwner } from "./projects.ts";
import type { AuditEntry, Client, Lead, ProjectService } from "./types.ts";

const client = (id: string, company: string, status: Client["status"], lead_id: string | null = null) =>
  ({ id, company, contact_name: null, status, lead_id }) as Client;
const lead = (id: string, name: string, archived = false) => ({ id, name, company: null, archived_at: archived ? "2026-01-01" : null }) as Lead;

test("owner values round-trip", () => {
  assert.deepEqual(parseOwner(ownerValue({ client_id: "c1", lead_id: null })), { client_id: "c1", lead_id: null });
  assert.deepEqual(parseOwner(ownerValue({ client_id: null, lead_id: "l1" })), { client_id: null, lead_id: "l1" });
  assert.equal(parseOwner(""), null);
  assert.equal(parseOwner("vendor:x"), null);
});

test("owner options: active clients first, only open leads", () => {
  const clients = [client("c1", "Zeta", "former"), client("c2", "Beta", "active", "l2"), client("c3", "Alpha", "active")];
  const leads = [lead("l1", "Open lead"), lead("l2", "Converted lead"), lead("l3", "Archived lead", true)];
  const o = ownerOptions(clients, leads);
  assert.deepEqual(o.clients.map((x) => x.label), ["Alpha", "Beta", "Zeta (former)"]);
  assert.deepEqual(o.leads.map((x) => x.value), ["lead:l1"]);
  // A project already on an archived lead keeps it as a choice.
  assert.deepEqual(ownerOptions(clients, leads, { lead_id: "l3", client_id: null }).leads.map((x) => x.value), ["lead:l3", "lead:l1"]);
});

test("totals and value labels", () => {
  const line = (project_id: string, billing: "monthly" | "once", amount: number) => ({ project_id, billing, amount }) as ProjectService;
  const t = totalsBy([line("a", "once", 8000), line("a", "monthly", 120), line("b", "monthly", 50)], (l) => l.project_id);
  assert.deepEqual(t.get("a"), { monthly: 120, once: 8000, n: 2 });
  assert.equal(valueLabel(t.get("a")), "$8,000 + $120/mo");
  assert.equal(valueLabel(t.get("b")), "$50/mo");
  assert.equal(valueLabel({ monthly: 0, once: 1200, n: 1 }), "$1,200");
  assert.equal(valueLabel(undefined), "–");
});

test("timeline wording for projects and credentials", () => {
  const entry = (table_name: AuditEntry["table_name"], action: AuditEntry["action"], old_data: Record<string, unknown> | null, new_data: Record<string, unknown> | null) =>
    ({ id: 1, at: "", actor: null, actor_role: "authenticated", action, table_name, row_id: null, old_data, new_data }) as AuditEntry;
  assert.equal(describeProject(entry("projects", "insert", null, { name: "Wi-Fi refresh" })), "Project Wi-Fi refresh added");
  assert.equal(describeProject(entry("projects", "update", { name: "Wi-Fi refresh", status: "potential" }, { name: "Wi-Fi refresh", status: "proposed" })), "Wi-Fi refresh: Potential → Proposed");
  assert.equal(describeProject(entry("projects", "update", { name: "X", status: "potential", lead_id: "l", client_id: null }, { name: "X", status: "potential", lead_id: null, client_id: "c" })), "X moved to a client");
  assert.equal(describeCredential(entry("project_credentials", "insert", null, { label: "Firewall" })), "Credential added: Firewall");
  assert.equal(describeCredential(entry("project_credentials", "update", { label: "Firewall" }, { label: "Meraki" })), "Credential renamed: Firewall → Meraki");
  assert.equal(describeCredential(entry("project_credentials", "delete", { label: "Meraki" }, null)), "Credential removed: Meraki");
});
