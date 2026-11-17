// quote-action: the dashboard's Send now, Resend, Send me a test, the
// Payments page's status, and Send test payment.
//
// 1. POST only, from admin.cyberx.la only, with a small body cap.
// 2. Every database call runs as the signed-in user (their token plus the
//    public key), so the database decides: the functions it calls check
//    is_admin() (allowlist plus MFA) themselves. No service role key.
// 3. Send now asks the database to freeze the next version and mark the quote
//    sent (public.proposal_send), then emails it through Resend. If the email
//    fails, the timeline says so and Resend tries again.
// 4. Send me a test goes to the notify address in Quotes, Settings, only.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY                         sending through notify.cyberx.la
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   optional; payments are off without them
//   PUBLISHABLE_KEY                        optional; only if the function says it's missing
// Supabase provides SUPABASE_URL.

import { ALLOWED_ORIGINS, BadRequest, MAX_BODY_BYTES, parseAction, publishableKey, recipients } from "./lib.ts";
import { fromHeader, quoteEmail, type MailContext } from "../_shared/emails.ts";
import { sendEmail } from "../_shared/mail.ts";
import { checkoutRequest, stripeMode } from "../_shared/stripe.ts";

const env = (k: string) => Deno.env.get(k);

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin", "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}
const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BadRequest("size");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("json");
  }
}

/** PostgREST RPC as the caller: their token decides what they can do. */
function asUser(authorization: string) {
  const base = `${env("SUPABASE_URL")}/rest/v1`;
  const headers = { "apikey": publishableKey(env), "Authorization": authorization, "Content-Type": "application/json" };
  return async (fn: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (!res.ok) {
      let message = "";
      try {
        message = String(JSON.parse(body).message ?? "");
      } catch {
        // not JSON
      }
      throw Object.assign(new Error(`database ${res.status}: ${body.slice(0, 300)}`), { status: res.status, dbMessage: message });
    }
    return body ? JSON.parse(body) : null;
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" }, headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" }, headers);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(authorization)) return reply(401, { error: "Sign in again." }, headers);

  let a;
  try {
    a = parseAction(await readBody(req));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  const rpc = asUser(authorization);
  try {
    if ((await rpc("is_admin", {})) !== true) return reply(403, { error: "Only an admin who finished MFA can do this." }, headers);
    const mode = stripeMode(env);

    if (a.action === "status") {
      await rpc("proposal_set_stripe_mode", { p_mode: mode }).catch(() => null);
      return reply(200, {
        ok: true, email: !!env("RESEND_API_KEY"), stripe: mode,
        stripe_key: !!env("STRIPE_SECRET_KEY"), stripe_webhook: !!env("STRIPE_WEBHOOK_SECRET"),
        webhook_url: `${env("SUPABASE_URL")}/functions/v1/stripe-webhook`,
      }, headers);
    }

    if (a.action === "test_payment") {
      if (mode === "off") return reply(409, { error: "Stripe isn't connected yet. Add the two Stripe secrets first (see README, Connect Stripe)." }, headers);
      const { url, init } = checkoutRequest(env("STRIPE_SECRET_KEY")!, {
        amount: 100, name: "cyberxLA test payment", description: "A $1 check that payments reach the admin. Refund it in Stripe afterwards.",
        email: null, success_url: "https://admin.cyberx.la/#/quotes/payments?test=paid", cancel_url: "https://admin.cyberx.la/#/quotes/payments?test=cancelled",
        metadata: { kind: "test" }, idempotency_key: `test-${crypto.randomUUID()}`,
      });
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.url) return reply(502, { error: `Stripe answered ${res.status}: ${String(out?.error?.message ?? "no checkout link").slice(0, 200)}` }, headers);
      await rpc("payment_test_started", { p_session: out.id, p_amount_cents: 100, p_livemode: !!out.livemode });
      return reply(200, { ok: true, url: out.url, mode }, headers);
    }

    // Send now freezes the version first; Resend and the test only read.
    const ctx = (a.action === "send"
      ? await rpc("proposal_send", { p_id: a.id, p_subject: a.subject, p_note: a.note })
      : await rpc("proposal_mail_context", { p_id: a.id, p_subject: a.subject, p_note: a.note })) as MailContext;
    if (a.action === "resend" && (ctx.version < 1 || ["draft", "scheduled", "revoked"].includes(ctx.status))) {
      return reply(409, { error: "This quote hasn't been sent yet, so there's nothing to resend. Use Send now." }, headers);
    }
    const mail = quoteEmail(ctx, a.action === "resend" ? "resend" : "send", a.action === "test");
    const to = recipients(a.action, ctx);
    try {
      const id = await sendEmail(env("RESEND_API_KEY"), {
        from: fromHeader(ctx.settings.from_name), to: to.to, cc: to.cc, reply_to: ctx.settings.reply_to,
        subject: mail.subject, html: mail.html, text: mail.text, tag: a.action === "test" ? "quote_test" : "quote",
      });
      if (a.action !== "send") await rpc("proposal_mail_logged", { p_id: a.id, p_kind: a.action === "test" ? "test_sent" : "resent", p_detail: { to: to.to, cc: to.cc, email_id: id } });
      return reply(200, { ok: true, to: to.to, cc: to.cc, version: ctx.version }, headers);
    } catch (e) {
      const why = (e as Error).message;
      await rpc("proposal_mail_logged", { p_id: a.id, p_kind: "email_failed", p_detail: { action: a.action, error: why.slice(0, 300) } }).catch(() => null);
      const what = a.action === "send" ? `Q${ctx.number.replace(/^Q/, "")} is marked sent (version ${ctx.version}), but the email didn't go: ${why}. Use Resend to try again.` : `The email didn't go: ${why}.`;
      return reply(502, { error: what, sent: a.action === "send" }, headers);
    }
  } catch (e) {
    const err = e as Error & { status?: number; dbMessage?: string };
    console.error("quote-action", a.action, a.id, err.message);
    if (err instanceof BadRequest) return reply(400, { error: "Add the recipient's email first." }, headers);
    if (err.status === 401) return reply(401, { error: "Sign in again." }, headers);
    if (err.status === 400 || err.status === 403 || err.status === 404) return reply(409, { error: err.dbMessage || "The database refused that." }, headers);
    return reply(503, { error: "Try again." }, headers);
  }
});
