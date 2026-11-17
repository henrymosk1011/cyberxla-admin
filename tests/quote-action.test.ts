import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequest, parseAction, recipients } from "../supabase/functions/quote-action/lib.ts";
import { acceptedEmail, fromHeader, ownerNotice, quoteEmail, quoteLink, type MailContext } from "../supabase/functions/_shared/emails.ts";

const ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const rejects = (body: unknown, field: string) => assert.throws(() => parseAction(body), (e) => e instanceof BadRequest && e.message === field);

test("send, resend and test need a quote id and a one line subject", () => {
  assert.deepEqual(parseAction({ action: "send", id: ID.toUpperCase(), subject: " Your quote ", note: "Hi\nthere" }), { action: "send", id: ID, subject: "Your quote", note: "Hi\nthere" });
  assert.deepEqual(parseAction({ action: "status" }), { action: "status", id: null, subject: "", note: "" });
  rejects({ action: "send", id: ID, subject: "" }, "subject");
  rejects({ action: "send", id: ID, subject: "a\r\nBcc: x@y.z" }, "subject");
  rejects({ action: "send", id: ID, subject: "x".repeat(201) }, "subject");
  rejects({ action: "send", id: ID, subject: "ok", note: "x".repeat(2001) }, "note");
  rejects({ action: "send", id: "1; drop", subject: "ok" }, "id");
  rejects({ action: "delete", id: ID, subject: "ok" }, "action");
  rejects({ action: "send", id: ID, subject: "ok", to: "evil@example.com" }, "body");
  rejects(null, "body");
});

const ctx = (patch: Partial<MailContext> = {}): MailContext => ({
  id: ID, number: "Q1001", version: 1, status: "sent", title: "Google Workspace migration", company: "Acme <Dental>", first_name: "Jane",
  to: "jane@acme.example", to_name: "Jane Doe", cc: ["ops@acme.example", "JANE@acme.example"], valid_until: "2026-12-17", token: "A".repeat(32),
  subject: null, note: null, settings: { notify_email: "henry@cyberx.la", reply_to: "henry@cyberx.la", from_name: "Henry at cyberxLA", stripe_mode: "off" }, ...patch,
});

test("a test goes only to the notify address; a send goes to the client and cc, once each", () => {
  assert.deepEqual(recipients("test", ctx()), { to: ["henry@cyberx.la"], cc: [] });
  assert.deepEqual(recipients("send", ctx()), { to: ["jane@acme.example"], cc: ["ops@acme.example"] });
  assert.throws(() => recipients("send", ctx({ to: null })), BadRequest);
});

test("the quote email: link, valid until, escaped text, plain text version", () => {
  const m = quoteEmail(ctx({ note: "Hi <b>Jane</b>,\n\nHere it is." }), "send");
  assert.equal(m.subject, "Your quote Q1001: Google Workspace migration");
  assert.ok(m.html.includes(quoteLink("A".repeat(32))));
  assert.ok(m.html.includes("December 17, 2026"));
  assert.ok(m.html.includes("Hi &lt;b&gt;Jane&lt;/b&gt;"));
  assert.ok(m.html.includes("Acme &lt;Dental&gt;"));
  assert.ok(!m.html.includes("<b>Jane</b>"));
  assert.ok(m.text.includes("View your quote: https://cyberx.la/proposal/?k="));
  assert.equal(quoteEmail(ctx({ subject: "Line one\nLine two" }), "send").subject, "Line one Line two");
});

test("Send me a test is marked as a test", () => {
  const m = quoteEmail(ctx({ version: 0 }), "send", true);
  assert.match(m.subject, /^\[Test\] /);
  assert.match(m.html, /Test email\. This is what jane@acme\.example will get\. The link works once the quote is sent\./);
});

test("reminders and the acceptance confirmation", () => {
  assert.match(quoteEmail(ctx(), "reminder_expiring").subject, /valid until December 17, 2026/);
  const s = { tier_name: "Pro", lines: [{ name: "Pro tier", billing: "once" as const, price: 550000 }], discount: null, once_total: 550000, monthly_total: 0, due_now: 275000, deposit: "deposit" as const, signer: "Jane Doe", pay: false };
  const off = acceptedEmail(ctx(), s);
  assert.match(off.text, /We'll send you an invoice for the deposit of \$2,750/);
  assert.ok(!off.html.includes("pay=1"));
  const on = acceptedEmail(ctx(), { ...s, pay: true });
  assert.ok(on.html.includes("&amp;pay=1"));
  assert.match(on.html, /Pay deposit/);
});

test("Henry's notices and a safe sender name", () => {
  assert.match(ownerNotice("accepted", ctx(), { by: "Jane", once_cents: 590000, selection: "Pro" }).subject, /accepted Q1001: \$5,900/);
  assert.equal(fromHeader('Evil" <x@y.z>\r\nBcc: a@b.c'), "Evil x@y.zBcc: a@b.c <quotes@notify.cyberx.la>");
});
