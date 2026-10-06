import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BadRequest, catalogFromRpc, parseSubmission as parse, priceQuote as price } from "../supabase/functions/submit-quote/lib.ts";

// Same shape as public.service_catalog(), seeded from the website.
const RPC = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const CATALOG = catalogFromRpc(RPC);
const parseSubmission = (b: unknown) => parse(b, CATALOG);
const priceQuote = (ids: string[], ws: number, sv: number) => price(CATALOG, ids, ws, sv);

const base = () => ({
  turnstileToken: "tok",
  name: "Jane Doe",
  company: "Acme",
  email: "Jane@Acme.com",
  phone: "(323) 555-0100",
  message: "Hi\nthere",
  workstations: 10,
  servers: 2,
  items: ["patching", "edr", "hardening", "pentest"],
});

const rejects = (patch: Record<string, unknown>, field: string) =>
  assert.throws(() => parseSubmission({ ...base(), ...patch }), (e) => e instanceof BadRequest && e.message === field);

test("prices on the server the same way the website does", () => {
  const { priced, lead } = parseSubmission(base());
  // units = 10 + 2*2.5 = 15; patching 10*15 + edr 8*15 = 270 -> 300 minimum
  assert.equal(priced.monthly_total, 300);
  assert.equal(priced.monthly_minimum_applied, true);
  // hardening 35*12 + pentest 5000
  assert.equal(priced.one_time_total, 5420);
  assert.equal(lead.email, "jane@acme.com");
});

test("ignores any prices the browser sends", () => {
  const { priced } = parseSubmission({ ...base(), monthly_total: 1, one_time_total: 1, workstations: 30, items: ["mdr"] });
  assert.equal(priced.monthly_total, 14 * 35);
  assert.equal(priced.items[0].unit_price, CATALOG.mdr.price);
});

test("no monthly minimum when only one-time items", () => {
  assert.deepEqual(
    [priceQuote(["irplan"], 5, 0).monthly_total, priceQuote(["irplan"], 5, 0).monthly_minimum_applied],
    [0, false],
  );
});

test("rejects bad input", () => {
  rejects({ items: [] }, "items");
  rejects({ items: ["patching", "patching"] }, "items");
  rejects({ items: ["nope"] }, "items");
  rejects({ items: ["__proto__"] }, "items");
  rejects({ items: ["toString"] }, "items");
  rejects({ items: "patching" }, "items");
  rejects({ email: "not-an-email" }, "email");
  rejects({ email: "a@b.c" }, "email");
  rejects({ name: "" }, "name");
  rejects({ name: "x".repeat(121) }, "name");
  rejects({ name: "Jane\nBcc: evil@x.com" }, "name");
  rejects({ name: { $ne: 1 } }, "name");
  rejects({ phone: "<script>" }, "phone");
  rejects({ message: "x".repeat(2001) }, "message");
  rejects({ message: "a\u0000b" }, "message");
  rejects({ workstations: -1 }, "workstations");
  rejects({ workstations: 1.5 }, "workstations");
  rejects({ workstations: "10" }, "workstations");
  rejects({ servers: 501 }, "servers");
  rejects({ turnstileToken: "" }, "turnstileToken");
  rejects({ website: "http://spam" }, "hp");
  assert.throws(() => parseSubmission(null), BadRequest);
  assert.throws(() => parseSubmission([]), BadRequest);
});

test("stores what was typed as plain text (escaping happens at display time)", () => {
  const { lead } = parseSubmission({ ...base(), company: "<img src=x onerror=alert(1)>" });
  assert.equal(lead.company, "<img src=x onerror=alert(1)>");
});

test("catalogFromRpc reads the RPC shape and skips malformed rows", () => {
  assert.equal(Object.keys(CATALOG).length, 30);
  assert.deepEqual(CATALOG.pentest, { name: "Penetration Testing", price: 5000, unit: "once", from: true });
  const c = catalogFromRpc([{ services: [{ id: "ok", name: "OK", price: "12.50", unit: "mo" }, { id: "bad", name: "Bad", price: 1, unit: "weekly" }, { id: 3 }] }]);
  assert.deepEqual(Object.keys(c), ["ok"]);
  assert.equal(c.ok!.price, 12.5);
  assert.equal(Object.keys(catalogFromRpc(null)).length, 0);
});

test("a service added in the dashboard is quotable; a removed one is rejected", () => {
  const live = catalogFromRpc([{ services: [{ id: "soc-lite", name: "SOC Lite", price: 9, unit: "dev" }] }]);
  const ok = parse({ ...base(), items: ["soc-lite"] }, live);
  assert.equal(ok.priced.items[0]!.cost, 9 * 15);
  assert.throws(() => parse({ ...base(), items: ["patching"] }, live), (e) => e instanceof BadRequest && e.message === "items");
});
