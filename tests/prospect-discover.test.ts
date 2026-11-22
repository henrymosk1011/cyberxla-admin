import { test } from "node:test";
import assert from "node:assert/strict";
import { apexDomain, apifyInput, BadRequest, DISCOVERY_SOURCE, MAX_LIMIT, ownSite, parseParams, publishableKey, toProspects } from "../supabase/functions/prospect-discover/lib.ts";

const base = { term: "dentists", location: "Glendale, CA", limit: 10, source: "yelp" as const };

test("parseParams accepts a well-formed body and trims text", () => {
  assert.deepEqual(parseParams(base), base);
  assert.deepEqual(parseParams({ ...base, term: "  roof  repair  " }).term, "roof repair");
  assert.equal(parseParams({ ...base, source: "google_places" }).source, "google_places");
});

test("parseParams rejects junk", () => {
  for (const bad of [
    null,
    [],
    "x",
    { ...base, source: "bing" },
    { ...base, term: "" },
    { ...base, location: "" },
    { ...base, limit: 0 },
    { ...base, limit: MAX_LIMIT + 1 },
    { ...base, limit: 2.5 },
    { ...base, limit: "10" },
    { ...base, extra: 1 },
    { term: "x", location: "y" },
  ]) {
    assert.throws(() => parseParams(bad), BadRequest);
  }
});

test("apifyInput asks for the term in the location with the cheap options", () => {
  const input = apifyInput(base);
  assert.deepEqual(input.searchStringsArray, ["dentists"]);
  assert.equal(input.locationQuery, "Glendale, CA");
  assert.equal(input.maxCrawledPlacesPerSearch, 10);
  assert.equal(input.scrapePlaceDetailPage, false);
  assert.equal(input.maxReviews, 0);
});

test("ownSite keeps a real site, adds https, drops social and tracking", () => {
  assert.equal(ownSite("example.com"), "https://example.com");
  assert.equal(ownSite("https://www.Example.com/Services/"), "https://www.example.com/Services/");
  assert.equal(ownSite("http://shop.example.co.uk?utm_source=x&id=7"), "http://shop.example.co.uk/?id=7");
  assert.equal(ownSite("https://www.facebook.com/acme"), null);
  assert.equal(ownSite("https://biz.yelp.com/acme"), null);
  assert.equal(ownSite(""), null);
  assert.equal(ownSite(null), null);
  assert.equal(ownSite("not a url"), null);
  assert.equal(ownSite("javascript:alert(1)"), null);
});

test("apexDomain returns a lowercase apex matching the prospects CHECK, or null", () => {
  assert.equal(apexDomain("https://www.Example.com/x"), "example.com");
  assert.equal(apexDomain("https://shop.example.co.uk"), "shop.example.co.uk");
  assert.equal(apexDomain(null), null);
  assert.equal(apexDomain("https://localhost"), null);
});

test("toProspects maps places, skips closed and nameless, and de-dupes by placeId", () => {
  const places = [
    { title: "Acme Dental", website: "acme-dental.com", phone: "818-555-0100", city: "Glendale", state: "CA", categoryName: "Dentist", placeId: "p1" },
    { title: "Acme Dental", website: "acme-dental.com", placeId: "p1" }, // same place twice in one run
    { title: "Closed Co", website: "closed.example", placeId: "p2", permanentlyClosed: true }, // skipped
    { title: "   ", website: "noname.example", placeId: "p3" }, // skipped: no name
    { title: "Social Only", website: "https://instagram.com/socialonly", placeId: "p4" }, // kept, no website
  ];
  const rows = toProspects(places);
  assert.equal(rows.length, 2);
  const acme = rows[0]!;
  assert.deepEqual(acme, {
    business_name: "Acme Dental",
    website: "https://acme-dental.com",
    domain: "acme-dental.com",
    phone: "818-555-0100",
    city: "Glendale",
    region: "CA",
    industry: "Dentist",
    source: DISCOVERY_SOURCE,
    source_ref: "p1",
  });
  assert.equal(rows[1]!.website, null);
  assert.equal(rows[1]!.domain, null);
  assert.equal(rows[1]!.source, "google_places");
});

test("toProspects caps every field to its column limit", () => {
  const [row] = toProspects([{
    title: "X".repeat(300),
    phone: "9".repeat(60),
    city: "C".repeat(200),
    state: "S".repeat(200),
    categoryName: "I".repeat(200),
    placeId: "Z".repeat(300),
  }]);
  assert.equal(row!.business_name.length, 200);
  assert.equal(row!.phone!.length, 40);
  assert.equal(row!.city!.length, 120);
  assert.equal(row!.region!.length, 120);
  assert.equal(row!.industry!.length, 120);
  assert.equal(row!.source_ref!.length, 200);
});

test("toProspects tolerates junk input", () => {
  assert.deepEqual(toProspects([]), []);
  assert.deepEqual(toProspects(null as unknown as unknown[]), []);
  assert.deepEqual(toProspects([null, 1, "x", {}]), []);
});

test("publishableKey prefers the explicit secret, then the list, then the legacy key", () => {
  assert.equal(publishableKey((k) => (k === "PUBLISHABLE_KEY" ? "pk_explicit" : undefined)), "pk_explicit");
  assert.equal(publishableKey((k) => (k === "SUPABASE_PUBLISHABLE_KEYS" ? JSON.stringify({ default: "pk_list" }) : undefined)), "pk_list");
  assert.equal(publishableKey((k) => (k === "SUPABASE_ANON_KEY" ? "anon" : undefined)), "anon");
  assert.throws(() => publishableKey(() => undefined), /missing publishable key/);
});
