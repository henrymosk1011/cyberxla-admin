// Stripe: whether it's connected, Checkout Sessions, and webhook signatures.
// Payments stay off until both secrets exist (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET); nothing here calls Stripe without them.

export type StripeMode = "off" | "test" | "live";

/** "off" until both secrets are set; then test or live from the key's prefix. */
export function stripeMode(get: (k: string) => string | undefined): StripeMode {
  const key = get("STRIPE_SECRET_KEY")?.trim(), hook = get("STRIPE_WEBHOOK_SECRET")?.trim();
  if (!key || !hook || !hook.startsWith("whsec_")) return "off";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return "off";
}

/** Form encoding the way Stripe's API reads nested fields: line_items[0][price_data][currency]=usd */
export function stripeForm(obj: Record<string, unknown>, prefix = ""): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(obj, prefix);
  return out;
}

export type CheckoutInput = {
  amount: number; // cents
  name: string;
  description: string;
  email: string | null;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
  idempotency_key: string;
};

/** The Checkout Session request: one line at the exact amount the server worked out. */
export function checkoutRequest(key: string, i: CheckoutInput) {
  if (!Number.isInteger(i.amount) || i.amount < 50 || i.amount > 99_999_999) throw new Error("amount out of range");
  const body = stripeForm({
    mode: "payment",
    "line_items": [{ quantity: 1, price_data: { currency: "usd", unit_amount: i.amount, product_data: { name: i.name.slice(0, 250), description: i.description.slice(0, 500) || undefined } } }],
    customer_email: i.email || undefined,
    success_url: i.success_url,
    cancel_url: i.cancel_url,
    client_reference_id: i.metadata.proposal_id,
    metadata: i.metadata,
    payment_intent_data: { metadata: i.metadata, description: i.name.slice(0, 250) },
    submit_type: "pay",
  });
  return {
    url: "https://api.stripe.com/v1/checkout/sessions",
    init: {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": i.idempotency_key, "Stripe-Version": "2024-06-20" },
      body: body.toString(),
    },
  };
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** Constant time compare of two strings. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Checks a Stripe-Signature header (t=...,v1=...) against the raw body, the
 * way Stripe documents it: HMAC SHA-256 of "t.body" with the endpoint secret,
 * any v1 matching, and the timestamp within `tolerance` seconds of now.
 */
export async function verifyStripeSignature(raw: string, header: string | null, secret: string, now = Math.floor(Date.now() / 1000), tolerance = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(t) || !sigs.length || Math.abs(now - t) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return sigs.some((s) => same(s, want));
}
