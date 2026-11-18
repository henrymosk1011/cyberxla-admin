// quote-public: the buttons on cyberx.la/proposal/ (Accept this quote,
// Request changes, Pay deposit or Pay now).
//
// 1. POST only, from cyberx.la only, with a small body cap.
// 2. Accept and Request changes need a Cloudflare Turnstile token, checked on
//    the server (action and hostname too); every action is rate limited per
//    IP in the database (IPs are stored only as salted hashes).
// 3. Accept recomputes every total from the version the client saw, refuses
//    a total that differs from the page's, and records an immutable snapshot
//    through proposal_api.accept (as the quote_intake role, which can only
//    call the proposal_api functions; no service role key).
// 4. Henry gets an email right away; the client gets a confirmation with
//    Pay when Stripe is connected.
// 5. Pay makes a Stripe Checkout Session on the server for exactly what's due
//    on the accepted quote. The browser never sets a price.
//
// Secrets: INTAKE_DB_URL, TURNSTILE_SECRET_KEY, IP_HASH_SALT (shared with
// submit-quote), RESEND_API_KEY, and optionally STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET (payments stay off without both).

import postgres from "npm:postgres@3.4.5";
import { ALLOWED_ORIGINS, BadRequest, MAX_BODY_BYTES, Mismatch, TURNSTILE_HOSTNAMES, acceptedSummary, checkSelection, parseRequest, selectionText } from "./lib.ts";
import { acceptedEmail, fromHeader, ownerNotice, quoteLink, type MailContext } from "../_shared/emails.ts";
import { sendEmail } from "../_shared/mail.ts";
import { checkoutRequest, stripeMode } from "../_shared/stripe.ts";
import { usd, type ProposalDoc } from "../_shared/proposal.ts";

const env = (k: string) => Deno.env.get(k);
function must(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

let sql: ReturnType<typeof postgres> | null = null;
const db = () => (sql ??= postgres(must("INTAKE_DB_URL"), { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5, ssl: "require" }));

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin", "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}
const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("size");
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BadRequest("size");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("json");
  }
}

async function verifyTurnstile(token: string, ip: string, action: string): Promise<boolean> {
  const form = new FormData();
  form.append("secret", must("TURNSTILE_SECRET_KEY"));
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  form.append("idempotency_key", crypto.randomUUID());
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return false;
  const out = await res.json();
  return out.success === true && TURNSTILE_HOSTNAMES.has(out.hostname) && out.action === action;
}

async function hashIp(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(must("IP_HASH_SALT")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip || "unknown"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Email, and if it went, mark Henry's notice as sent (the scheduler retries the rest). */
async function notify(eventId: number | null, mail: { subject: string; html: string; text: string }, to: string) {
  try {
    await sendEmail(env("RESEND_API_KEY"), { from: fromHeader("cyberxLA Quotes"), to: [to], subject: mail.subject, html: mail.html, text: mail.text, tag: "quote_notice" });
    if (eventId) await db()`select proposal_api.mark_notified(${[eventId]}::bigint[])`;
  } catch (e) {
    console.error("notice email", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" }, headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" }, headers);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(415, { error: "unsupported media type" }, headers);

  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  let r;
  try {
    r = parseRequest(await readBody(req));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  try {
    const ipHash = await hashIp(ip);
    const mode = stripeMode(env);

    if (r.action === "pay") {
      if (mode === "off") {
        await db()`select proposal_api.set_stripe_mode('off')`.catch(() => null);
        return reply(409, { error: "off" }, headers);
      }
      const [{ c }] = await db()`select proposal_api.pay_context(${r.token}, ${ipHash}) as c`;
      const left = Number(c.due_cents) - Number(c.paid_cents);
      if (left <= 0) return reply(409, { error: "paid" }, headers);
      if (left < 50) return reply(409, { error: "small" }, headers);
      const what = c.kind === "full" ? "Payment" : "Deposit";
      const { url, init } = checkoutRequest(must("STRIPE_SECRET_KEY"), {
        amount: left, name: `${what} for quote ${c.number}: ${c.title}`.slice(0, 250), description: `${c.company}. ${usd(left)} of ${usd(Number(c.due_cents))} due at acceptance.`,
        email: c.email ?? null, success_url: quoteLink(r.token, "&paid=1"), cancel_url: quoteLink(r.token),
        metadata: { proposal_id: c.id, acceptance_id: c.acceptance_id, kind: c.kind, quote: c.number },
        // One session per amount per hour: a double click gets the same checkout.
        idempotency_key: `pay-${c.acceptance_id}-${left}-${Math.floor(Date.now() / 3_600_000)}`,
      });
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || typeof out?.url !== "string") {
        console.error("stripe checkout", res.status, out?.error?.message);
        return reply(502, { error: "stripe" }, headers);
      }
      await db()`select proposal_api.payment_started(${c.id}::uuid, ${c.acceptance_id}::uuid, ${c.kind}, ${left}, ${out.id}, ${!!out.livemode}, ${c.email ?? null})`;
      return reply(200, { ok: true, url: out.url }, headers);
    }

    try {
      if (!(await verifyTurnstile(r.turnstile, ip, r.action))) return reply(403, { error: "verification failed" }, headers);
    } catch (e) {
      console.error("turnstile", (e as Error).message);
      return reply(503, { error: "try again" }, headers);
    }

    if (r.action === "changes") {
      const [{ c }] = await db()`select proposal_api.request_changes(${r.token}, ${db().json({ name: r.name, email: r.email, message: r.message })}, ${ipHash}) as c`;
      const ctx = c as MailContext & { event_id: number };
      await notify(ctx.event_id, ownerNotice("changes", ctx, { name: r.name, email: r.email, message: r.message, expired: ctx.status === "expired" }), ctx.settings.notify_email);
      return reply(200, { ok: true }, headers);
    }

    // Accept: totals from the version the client saw, then the snapshot.
    const [{ q }] = await db()`select proposal_api.for_token(${r.token}) as q`;
    if (!q) return reply(404, { error: "not available" }, headers);
    if (q.status === "accepted") return reply(409, { error: "accepted" }, headers);
    if (q.version !== r.version) return reply(409, { error: "changed" }, headers);
    const doc = q.doc as ProposalDoc;
    const t = checkSelection(doc, r);
    const [{ c }] = await db()`select proposal_api.accept(${r.token}, ${r.version}, ${db().json({
      tier: t.tier, addons: t.addons, lines: t.lines, totals: t, name: r.name, title: r.title, email: r.email, signature: r.signature, agree: true,
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400),
    })}, ${ipHash}) as c`;
    const ctx = c as MailContext & { event_id: number };
    const pay = mode !== "off" && t.due_now > 0;
    const sel = selectionText(doc, t.tier, t.addons);
    await notify(ctx.event_id, ownerNotice("accepted", ctx, { by: r.name, selection: sel, once_cents: t.once_total, monthly_cents: t.monthly_total, due_cents: t.due_now }), ctx.settings.notify_email);
    // Whether the confirmation went, so the page only says so when it did.
    let emailed = false;
    try {
      const mail = acceptedEmail(ctx, acceptedSummary(doc, t, r.name, pay));
      const cc = ctx.to && ctx.to.toLowerCase() !== r.email ? [ctx.to] : [];
      await sendEmail(env("RESEND_API_KEY"), { from: fromHeader(ctx.settings.from_name), to: [r.email], cc, reply_to: ctx.settings.reply_to, subject: mail.subject, html: mail.html, text: mail.text, tag: "quote_accepted" });
      emailed = true;
    } catch (e) {
      console.error("confirmation email", (e as Error).message);
      await db()`select proposal_api.log_email_failed(${ctx.id}::uuid, ${db().json({ what: "confirmation", error: (e as Error).message })})`.catch(() => null);
    }
    return reply(200, { ok: true, due_now: t.due_now, pay, emailed }, headers);
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    if (e instanceof Mismatch) return reply(409, { error: "total" }, headers);
    const code = (e as { code?: string }).code;
    if (code === "P0429") return reply(429, { error: "too many requests" }, headers);
    if (code === "P0404") return reply(404, { error: "not available" }, headers);
    if (code === "P0409") return reply(409, { error: "accepted" }, headers);
    if (code === "P0408") return reply(409, { error: "changed" }, headers);
    if (code === "P0410") return reply(410, { error: "expired" }, headers);
    console.error("quote-public", r.action, code ?? (e as Error).message);
    return reply(503, { error: "try again" }, headers);
  }
});
