// stripe-webhook: Stripe tells us a payment went through (or failed, expired,
// or was refunded).
//
// 1. The Stripe-Signature header is checked against the raw body with
//    STRIPE_WEBHOOK_SECRET (HMAC SHA-256, 5 minute tolerance) before anything
//    is read. Without the secret, nothing is accepted.
// 2. Each event is applied once: proposal_api.stripe_apply stores the event id
//    in the same transaction as the change, so Stripe's retries and duplicates
//    never count a payment twice, and a failure leaves nothing half done.
// 3. A payment that arrives emails Henry right away.
// Logs in as quote_intake (INTAKE_DB_URL); no service role key.

import postgres from "npm:postgres@3.4.5";
import { MAX_BODY_BYTES, eventToApply } from "./lib.ts";
import { verifyStripeSignature } from "../_shared/stripe.ts";
import { fromHeader, ownerNotice, type MailContext } from "../_shared/emails.ts";
import { sendEmail } from "../_shared/mail.ts";

const env = (k: string) => Deno.env.get(k);
let sql: ReturnType<typeof postgres> | null = null;
function db() {
  const url = env("INTAKE_DB_URL");
  if (!url) throw new Error("missing secret INTAKE_DB_URL");
  return (sql ??= postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5, ssl: "require" }));
}
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) return reply(503, { error: "payments aren't connected" });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return reply(413, { error: "too large" });
  if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret))) return reply(400, { error: "bad signature" });

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return reply(400, { error: "json" });
  }
  if (typeof evt?.id !== "string" || !/^evt_[A-Za-z0-9_]{6,250}$/.test(evt.id)) return reply(400, { error: "event id" });
  const apply = eventToApply(evt);
  if (!apply) return reply(200, { ok: true, ignored: evt.type });

  try {
    const [{ r }] = await db()`select proposal_api.stripe_apply(${evt.id}, ${String(evt.type)}, ${db().json(apply)}) as r`;
    if (r?.changed && r.status === "paid" && r.quote) {
      const q = r.quote as MailContext;
      try {
        const m = ownerNotice("payment", q, { amount_cents: r.amount_cents, kind: r.kind, livemode: r.livemode });
        await sendEmail(env("RESEND_API_KEY"), { from: fromHeader("cyberxLA Quotes"), to: [q.settings.notify_email], subject: m.subject, html: m.html, text: m.text, tag: "quote_notice" });
        if (r.event_id) await db()`select proposal_api.mark_notified(${[r.event_id]}::bigint[])`;
      } catch (e) {
        // The scheduler sends it later (the notice stays queued).
        console.error("payment notice", (e as Error).message);
      }
    }
    return reply(200, { ok: true, ...(r?.duplicate ? { duplicate: true } : {}) });
  } catch (e) {
    console.error("stripe-webhook", (e as { code?: string }).code ?? (e as Error).message);
    // Stripe retries on a non 2xx answer.
    return reply(500, { error: "try again" });
  }
});
