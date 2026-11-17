// quote-cron: the quotes' scheduler, woken by the database (pg_cron runs
// proposal_api.tick every minute, which calls this only when something is due,
// and at least hourly).
//
// 1. POST only, server to server: a browser request (with an Origin) is refused.
// 2. The caller must send the key pg_cron keeps in Vault as x-cron-key; this
//    function asks the database whether it's right (proposal_api.cron_key_ok),
//    so the key exists only in the database. It logs in as quote_intake.
// 3. Jobs, each safe to repeat: Send later (each quote is claimed and frozen in
//    one step, so it can't go twice), Henry's notices (first view, changes,
//    accepted, payment) with retries, follow up reminders (9 AM to 5 PM
//    Pacific), and keeping the Stripe on/off flag in step with the secrets.
//
// Secrets: INTAKE_DB_URL, RESEND_API_KEY (shared), STRIPE_* (optional).

import postgres from "npm:postgres@3.4.5";
import { fromHeader, ownerNotice, quoteEmail, type MailContext, type NoticeKind } from "../_shared/emails.ts";
import { sendEmail } from "../_shared/mail.ts";
import { stripeMode } from "../_shared/stripe.ts";

const env = (k: string) => Deno.env.get(k);
let sql: ReturnType<typeof postgres> | null = null;
function db() {
  const url = env("INTAKE_DB_URL");
  if (!url) throw new Error("missing secret INTAKE_DB_URL");
  return (sql ??= postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5, ssl: "require" }));
}
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: HEADERS });

async function mailQuote(ctx: MailContext, kind: "send" | "reminder_unviewed" | "reminder_expiring") {
  const m = quoteEmail(ctx, kind);
  await sendEmail(env("RESEND_API_KEY"), {
    from: fromHeader(ctx.settings.from_name), to: [ctx.to!], cc: kind === "send" ? ctx.cc.filter((x) => x.toLowerCase() !== ctx.to!.toLowerCase()) : [],
    reply_to: ctx.settings.reply_to, subject: m.subject, html: m.html, text: m.text, tag: kind === "send" ? "quote" : "quote_reminder",
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  if (req.headers.has("origin")) return reply(403, { error: "forbidden" });
  const key = req.headers.get("x-cron-key") ?? "";
  await req.body?.cancel();
  try {
    const [{ ok }] = await db()`select proposal_api.cron_key_ok(${key}) as ok`;
    if (!ok) return reply(401, { error: "unauthorized" });
    const done = { sent: 0, reminders: 0, notices: 0, failed: 0 };

    await db()`select proposal_api.set_stripe_mode(${stripeMode(env)})`;

    const [{ list: due }] = await db()`select proposal_api.claim_scheduled() as list`;
    for (const ctx of due as MailContext[]) {
      try { await mailQuote(ctx, "send"); done.sent++; } catch (e) {
        done.failed++;
        await db()`select proposal_api.log_email_failed(${ctx.id}::uuid, ${db().json({ what: "scheduled send", error: (e as Error).message })})`;
      }
    }

    const [{ list: reminders }] = await db()`select proposal_api.claim_reminders() as list`;
    for (const ctx of reminders as (MailContext & { reminder: "unviewed" | "expiring" })[]) {
      try { await mailQuote(ctx, ctx.reminder === "unviewed" ? "reminder_unviewed" : "reminder_expiring"); done.reminders++; } catch (e) {
        done.failed++;
        await db()`select proposal_api.log_email_failed(${ctx.id}::uuid, ${db().json({ what: "reminder", error: (e as Error).message })})`;
      }
    }

    const [{ list: notices }] = await db()`select proposal_api.pending_notices() as list`;
    const sentIds: number[] = [], failedIds: number[] = [];
    for (const n of notices as { event_id: number; notify: string; detail: Record<string, unknown>; quote: MailContext }[]) {
      const kind = (n.notify === "first_view" ? "first_view" : n.notify) as NoticeKind;
      const d = n.detail ?? {};
      const detail = kind === "accepted" ? { by: d.by, selection: [d.tier, ...(Array.isArray(d.addons) ? d.addons : [])].join(", "), once_cents: Math.round(Number(d.once_total ?? 0) * 100), monthly_cents: Math.round(Number(d.monthly_total ?? 0) * 100) }
        : kind === "payment" ? { amount_cents: Math.round(Number(d.amount ?? 0) * 100), kind: d.kind, livemode: d.livemode }
        : d;
      try {
        const m = ownerNotice(kind, n.quote, detail);
        await sendEmail(env("RESEND_API_KEY"), { from: fromHeader("cyberxLA Quotes"), to: [n.quote.settings.notify_email], subject: m.subject, html: m.html, text: m.text, tag: "quote_notice" });
        sentIds.push(n.event_id);
      } catch (e) {
        console.error("notice", n.event_id, (e as Error).message);
        failedIds.push(n.event_id);
      }
    }
    if (sentIds.length) await db()`select proposal_api.mark_notified(${sentIds}::bigint[])`;
    if (failedIds.length) await db()`select proposal_api.notice_failed(${failedIds}::bigint[])`;
    done.notices = sentIds.length;
    done.failed += failedIds.length;

    await db()`select proposal_api.cron_seen()`;
    if (done.sent || done.reminders || done.notices || done.failed) console.log("quote-cron", JSON.stringify(done));
    return reply(200, { ok: true, ...done });
  } catch (e) {
    console.error("quote-cron", (e as { code?: string }).code ?? (e as Error).message);
    return reply(500, { error: "failed" });
  }
});
