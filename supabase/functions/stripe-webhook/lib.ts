// Turning a verified Stripe event into what the database records
// (proposal_api.stripe_apply). Kept apart from the HTTP handler so it can be
// tested with Stripe's own event shapes (tests/stripe.test.ts).

export const MAX_BODY_BYTES = 256 * 1024;

export type Apply = {
  session_id: string | null;
  payment_intent: string | null;
  amount_cents: number;
  livemode: boolean;
  status: "paid" | "failed" | "expired" | "refunded";
  proposal_id: string | null;
  acceptance_id: string | null;
  kind: string | null;
  email: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The payment change an event means, or null for events we don't use. */
export function eventToApply(evt: { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: Record<string, unknown> } }): Apply | null {
  const o = evt?.data?.object ?? {};
  const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const base = {
    session_id: null as string | null, payment_intent: str(o.payment_intent), amount_cents: Number(o.amount_total ?? 0) || 0, livemode: evt.livemode === true,
    proposal_id: str(meta.proposal_id), acceptance_id: str(meta.acceptance_id), kind: str(meta.kind),
    email: str((o.customer_details as Record<string, unknown> | undefined)?.email) ?? str(o.customer_email),
  };
  switch (evt.type) {
    case "checkout.session.completed":
      // Card payments are paid at completion; slower methods finish later (async_payment_succeeded).
      return o.payment_status === "paid" ? { ...base, session_id: str(o.id), status: "paid" } : null;
    case "checkout.session.async_payment_succeeded":
      return { ...base, session_id: str(o.id), status: "paid" };
    case "checkout.session.async_payment_failed":
      return { ...base, session_id: str(o.id), status: "failed" };
    case "checkout.session.expired":
      return { ...base, session_id: str(o.id), status: "expired" };
    case "charge.refunded":
      return o.refunded === true ? { ...base, session_id: null, payment_intent: str(o.payment_intent), amount_cents: Number(o.amount_refunded ?? 0) || 0, status: "refunded" } : null;
    default:
      return null;
  }
}

/** The events to select in Stripe for this endpoint. */
export const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired", "charge.refunded"] as const;
