import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BadRequest, Mismatch, acceptedSummary, checkSelection, parseRequest } from "../supabase/functions/quote-public/lib.ts";
import { normalizeDoc, totals } from "../supabase/functions/_shared/proposal.ts";
import { acceptedEmail, ownerNotice, type MailContext } from "../supabase/functions/_shared/emails.ts";

const DOC = normalizeDoc(JSON.parse(readFileSync(new URL("./fixtures/workspace-template.json", import.meta.url), "utf8")));
const TOKEN = "A".repeat(32);
const accept = (patch: Record<string, unknown> = {}) => ({
  action: "accept", token: TOKEN, version: 1, turnstileToken: "t", website: "", tier: "pro", addons: ["usb"],
  expected_once: 590000, expected_monthly: 0, name: "Jane Doe", title: "Owner", email: "Jane@Acme.example", agree: true, signature: "Jane Doe", ...patch,
});
const rejects = (body: unknown, field: string) => assert.throws(() => parseRequest(body), (e) => e instanceof BadRequest && e.message === field);

test("accept: valid input, normalized", () => {
  const r = parseRequest(accept());
  assert.equal(r.action, "accept");
  if (r.action !== "accept") return;
  assert.equal(r.email, "jane@acme.example");
  assert.deepEqual(r.addons, ["usb"]);
});

test("accept: every field is checked", () => {
  rejects(accept({ token: "short" }), "token");
  rejects(accept({ website: "http://spam" }), "hp");
  rejects(accept({ agree: false }), "agree");
  rejects(accept({ name: "" }), "name");
  rejects(accept({ name: "x".repeat(121) }), "name");
  rejects(accept({ name: "<script>" }), "name");
  rejects(accept({ email: "nope" }), "email");
  rejects(accept({ signature: "" }), "signature");
  rejects(accept({ tier: "Pro!" }), "tier");
  rejects(accept({ addons: ["usb", "usb"] }), "addons");
  rejects(accept({ addons: "usb" }), "addons");
  rejects(accept({ expected_once: -1 }), "expected_once");
  rejects(accept({ expected_once: 1.5 }), "expected_once");
  rejects(accept({ version: 0 }), "version");
  rejects(accept({ turnstileToken: "" }), "turnstileToken");
  rejects({ ...accept(), action: "delete" }, "action");
  rejects(null, "body");
});

test("changes and pay", () => {
  const c = parseRequest({ action: "changes", token: TOKEN, turnstileToken: "t", name: "Jane", email: "j@acme.example", message: "Can we\nadd one more laptop?" });
  assert.equal(c.action, "changes");
  rejects({ action: "changes", token: TOKEN, turnstileToken: "t", name: "Jane", email: "j@acme.example", message: "" }, "message");
  rejects({ action: "changes", token: TOKEN, turnstileToken: "t", name: "Jane", email: "j@acme.example", message: "x".repeat(2001) }, "message");
  assert.deepEqual(parseRequest({ action: "pay", token: TOKEN }), { action: "pay", token: TOKEN });
});

test("the server's totals decide; a tampered page total is refused", () => {
  const t = checkSelection(DOC, { tier: "pro", addons: ["usb"], expected_once: 590000, expected_monthly: 0 });
  assert.equal(t.once_total, 590000);
  assert.throws(() => checkSelection(DOC, { tier: "pro", addons: ["usb"], expected_once: 100, expected_monthly: 0 }), Mismatch);
  assert.throws(() => checkSelection(DOC, { tier: "nope", addons: [], expected_once: 0, expected_monthly: 0 }), BadRequest);
  // Complete already includes the USB keys: ticking them can't add a line.
  assert.throws(() => checkSelection(DOC, { tier: "complete", addons: ["usb"], expected_once: 840000, expected_monthly: 0 }), BadRequest);
});

test("the confirmation email summary follows the deposit and Stripe", () => {
  const doc = normalizeDoc({ ...structuredClone(DOC), payment: { mode: "deposit", deposit_kind: "percent", deposit_value: 50 } });
  const t = totals(doc, "pro", []);
  assert.deepEqual([acceptedSummary(doc, t, "Jane", false).pay, acceptedSummary(doc, t, "Jane", true).pay, acceptedSummary(doc, t, "Jane", true).due_now], [false, true, 275000]);
});

test("emails for a monthly only selection don't show a $0 one time total", () => {
  const ctx: MailContext = {
    id: "00000000-0000-0000-0000-000000000000", number: "Q2000", version: 1, status: "accepted", title: "Managed IT", company: "Example Co",
    first_name: "Pat", to: "pat@example.test", to_name: "Pat", cc: [], valid_until: "2026-12-31", token: "x".repeat(32), subject: null, note: null,
    settings: { notify_email: "owner@example.test", reply_to: "owner@example.test", from_name: "cyberxLA", stripe_mode: "off" },
  };
  const mail = acceptedEmail(ctx, {
    tier_name: "Managed", lines: [{ name: "Managed tier, monthly", billing: "monthly", price: 35000 }], discount: null,
    once_total: 0, monthly_total: 35000, due_now: 0, deposit: "none", signer: "Pat Example", pay: false,
  });
  assert.doesNotMatch(mail.text, /One time total/);
  assert.match(mail.text, /Monthly: \$350\/mo/);
  const notice = ownerNotice("accepted", ctx, { by: "Pat Example", selection: "Managed", once_cents: 0, monthly_cents: 35000 });
  assert.match(notice.subject, /accepted Q2000: \$350\/mo$/);
  assert.doesNotMatch(notice.text, /One time total/);
  // Both kinds of price: both shown.
  assert.match(ownerNotice("accepted", ctx, { once_cents: 420000, monthly_cents: 35000 }).subject, /\$4,200 plus \$350\/mo$/);
});
