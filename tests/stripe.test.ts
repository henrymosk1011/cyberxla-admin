import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutRequest, stripeForm, stripeMode, verifyStripeSignature } from "../supabase/functions/_shared/stripe.ts";
import { eventToApply, EVENTS } from "../supabase/functions/stripe-webhook/lib.ts";

const SECRET = "whsec_test_secret_for_unit_tests";
async function sign(body: string, t: number, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

test("payments are off until both secrets exist; test or live from the key", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assert.equal(stripeMode(env({})), "off");
  assert.equal(stripeMode(env({ STRIPE_SECRET_KEY: "sk_test_x" })), "off");
  assert.equal(stripeMode(env({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "nope" })), "off");
  assert.equal(stripeMode(env({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })), "test");
  assert.equal(stripeMode(env({ STRIPE_SECRET_KEY: "rk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })), "live");
  assert.equal(stripeMode(env({ STRIPE_SECRET_KEY: "pk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })), "off");
});

test("webhook signatures: right secret, any v1, within 5 minutes", async () => {
  const body = JSON.stringify({ id: "evt_123456", type: "checkout.session.completed" });
  const now = 1_800_000_000;
  const good = await sign(body, now);
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=${good}`, SECRET, now), true);
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=deadbeef,v1=${good}`, SECRET, now), true);
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=${good}`, "whsec_other", now), false);
  assert.equal(await verifyStripeSignature(body + " ", `t=${now},v1=${good}`, SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=${good}`, SECRET, now + 301), false);
  assert.equal(await verifyStripeSignature(body, `t=${now}`, SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, null, SECRET, now), false);
});

// Shaped like Stripe's own events (fields trimmed).
const session = (over: Record<string, unknown> = {}) => ({
  id: "evt_1QabcDEF", type: "checkout.session.completed", livemode: false,
  data: { object: { id: "cs_test_a1B2c3D4e5", object: "checkout.session", amount_total: 275000, currency: "usd", payment_status: "paid", payment_intent: "pi_3Qabc",
    customer_details: { email: "jane@acme.example" }, metadata: { proposal_id: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", acceptance_id: "0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d", kind: "deposit", quote: "Q1001" }, ...over } },
});

test("mocked events: paid, pending, async results, expired, refunded, and the rest ignored", () => {
  assert.deepEqual(eventToApply(session()), {
    session_id: "cs_test_a1B2c3D4e5", payment_intent: "pi_3Qabc", amount_cents: 275000, livemode: false, status: "paid",
    proposal_id: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", acceptance_id: "0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d", kind: "deposit", email: "jane@acme.example",
  });
  assert.equal(eventToApply(session({ payment_status: "unpaid" })), null);
  assert.equal(eventToApply({ ...session(), type: "checkout.session.async_payment_succeeded" })!.status, "paid");
  assert.equal(eventToApply({ ...session(), type: "checkout.session.async_payment_failed" })!.status, "failed");
  assert.equal(eventToApply({ ...session(), type: "checkout.session.expired" })!.status, "expired");
  const refund = eventToApply({ id: "evt_2", type: "charge.refunded", livemode: true, data: { object: { refunded: true, amount_refunded: 275000, payment_intent: "pi_3Qabc" } } })!;
  assert.deepEqual([refund.status, refund.payment_intent, refund.session_id, refund.livemode], ["refunded", "pi_3Qabc", null, true]);
  assert.equal(eventToApply({ id: "evt_3", type: "customer.created", data: { object: {} } }), null);
  assert.ok(EVENTS.includes("checkout.session.completed"));
});

test("Checkout is made on the server for the exact amount, form encoded the way Stripe reads it", () => {
  const { url, init } = checkoutRequest("sk_test_x", { amount: 275000, name: "Deposit for quote Q1001", description: "Acme", email: "jane@acme.example",
    success_url: "https://cyberx.la/proposal/?k=A&paid=1", cancel_url: "https://cyberx.la/proposal/?k=A", metadata: { proposal_id: "p", kind: "deposit" }, idempotency_key: "pay-1" });
  assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
  const f = new URLSearchParams(init.body);
  assert.equal(f.get("line_items[0][price_data][unit_amount]"), "275000");
  assert.equal(f.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(f.get("mode"), "payment");
  assert.equal(f.get("metadata[kind]"), "deposit");
  assert.equal(f.get("payment_intent_data[metadata][proposal_id]"), "p");
  assert.equal(init.headers["Idempotency-Key"], "pay-1");
  assert.throws(() => checkoutRequest("sk", { amount: 10, name: "", description: "", email: null, success_url: "", cancel_url: "", metadata: {}, idempotency_key: "k" }), /range/);
  assert.equal(stripeForm({ a: [{ b: 1 }], c: undefined }).toString(), "a%5B0%5D%5Bb%5D=1");
});
