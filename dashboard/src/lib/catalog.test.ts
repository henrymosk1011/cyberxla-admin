import { test } from "node:test";
import assert from "node:assert/strict";
import { lineAmount, priceQuote, slugify, unitPrice } from "./catalog.ts";
import type { ServiceRow } from "./types.ts";

const svc = (id: string, price: number, unit: ServiceRow["unit"], extra: Partial<ServiceRow> = {}): ServiceRow => ({
  id, category_id: "c", name: id.toUpperCase(), description: "", price, unit, price_from: false,
  in_packages: false, active: true, locked: false, sort: 0, ...extra,
});

test("slugify makes unique, url-safe ids", () => {
  assert.equal(slugify("Dark Web Monitoring"), "dark-web-monitoring");
  assert.equal(slugify("SPF, DKIM & DMARC"), "spf-dkim-and-dmarc");
  assert.equal(slugify("Café Wi-Fi"), "cafe-wi-fi");
  assert.equal(slugify("EDR", ["edr", "edr-2"]), "edr-3");
  assert.equal(slugify("!!!"), "item");
});

test("unitPrice and lineAmount", () => {
  assert.equal(unitPrice(svc("a", 10, "dev")), "$10 /device/mo");
  assert.equal(unitPrice(svc("b", 5000, "once", { price_from: true })), "from $5,000 one time");
  assert.equal(unitPrice(svc("c", 12.5, "mo")), "$12.50 /mo");
  assert.equal(lineAmount(svc("a", 8, "dev"), 10, 2), 120);
  assert.equal(lineAmount(svc("a", 35, "devonce"), 10, 2), 420);
  assert.equal(lineAmount(svc("a", 150, "mo"), 10, 2), 150);
});

test("priceQuote uses whatever the catalog currently says", () => {
  const list = [svc("edr", 8, "dev"), svc("plan", 2500, "once")];
  const p = priceQuote(list, ["edr", "plan"], 40, 0);
  assert.equal(p.monthly_total, 320);
  assert.equal(p.one_time_total, 2500);
  list[0]!.price = 9;
  assert.equal(priceQuote(list, ["edr"], 40, 0).monthly_total, 360);
});
