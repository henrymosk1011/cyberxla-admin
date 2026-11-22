import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParams, isPublicHost, BadRequest } from "../supabase/functions/quick-scan/lib.ts";
import { collect, analyze, type Net } from "../supabase/functions/quick-scan/scan.ts";

// A fake network adapter so the engine runs with no real network.
const fakeNet = (over: Partial<Net> = {}): Net => ({
  fetchPage: async () => ({ status: 200, headers: { "content-type": "text/html" }, setCookies: [], body: "<html><body>hi</body></html>", finalUrl: "https://example.com/" }),
  httpsRedirect: async () => true,
  tlsCert: async () => ({ ok: true, issuer: "Let's Encrypt", valid_to: "2027-01-01", daysLeft: 70, expired: false, protocol: "TLSv1.3" }),
  txt: async () => [],
  mx: async () => [],
  caa: async () => [],
  ctSubdomains: async () => [],
  ...over,
});

test("parseParams normalizes a bare domain", () => {
  assert.deepEqual(parseParams({ url: "Example.com" }), { target: "https://example.com/", domain: "example.com" });
  assert.deepEqual(parseParams({ url: "https://www.shop.example.com/path?a=1" }), { target: "https://www.shop.example.com/path?a=1", domain: "shop.example.com" });
});

test("parseParams rejects junk and internal targets", () => {
  for (const bad of [null, [], "x", {}, { url: 123 }, { url: "" }, { url: "ftp://example.com" }, { url: "example" }, { url: "http://localhost" }, { url: "127.0.0.1" }, { url: "10.0.0.5" }, { url: "192.168.1.1" }, { url: "http://foo.internal" }, { url: "example.com", extra: 1 }]) {
    assert.throws(() => parseParams(bad), BadRequest, `should reject ${JSON.stringify(bad)}`);
  }
});

test("isPublicHost allows real domains and public IPs, blocks private ranges", () => {
  assert.equal(isPublicHost("example.com"), true);
  assert.equal(isPublicHost("8.8.8.8"), true);
  assert.equal(isPublicHost("172.15.0.1"), true); // just outside the private block
  assert.equal(isPublicHost("172.16.0.1"), false);
  assert.equal(isPublicHost("169.254.1.1"), false);
  assert.equal(isPublicHost("localhost"), false);
});

test("analyze: a bare site with no headers or DNS protection grades D with the expected findings", async () => {
  const obs = await collect("example.com", fakeNet());
  const a = analyze(obs);
  const ids = a.findings.map((f) => f.id);
  assert.ok(ids.includes("dmarc"), "flags missing DMARC");
  assert.ok(ids.includes("spf"), "flags missing SPF");
  assert.ok(ids.includes("hsts"), "flags missing HSTS");
  assert.ok(ids.includes("tls-ok"), "notes the valid certificate");
  // 100 - (dmarc 15 + hsts 8 + csp 8 + spf 8 + nosniff 3 + xfo 3) = 55 -> D
  assert.equal(a.score, 55);
  assert.equal(a.grade, "D");
});

test("analyze: a hardened site grades A", async () => {
  const obs = await collect("example.com", fakeNet({
    fetchPage: async () => ({
      status: 200,
      headers: {
        "content-type": "text/html",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
      setCookies: ["sid=1; Secure; HttpOnly; SameSite=Lax"],
      body: "<html></html>",
      finalUrl: "https://example.com/",
    }),
    txt: async (name: string) => (name.startsWith("_dmarc") ? ["v=DMARC1; p=reject"] : ["v=spf1 include:_spf.google.com ~all"]),
    caa: async () => ['0 issue "letsencrypt.org"'],
  }));
  const a = analyze(obs);
  assert.equal(a.grade, "A");
  assert.equal(a.findings.filter((f) => !f.passed && f.severity !== "info").length, 0);
});

test("analyze: an unreachable site yields no findings (handler reports it separately)", async () => {
  const obs = await collect("example.com", fakeNet({ fetchPage: async () => { throw new Error("refused"); } }));
  assert.equal(obs.reachable, false);
});
