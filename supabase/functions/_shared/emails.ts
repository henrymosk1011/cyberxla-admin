// Every email about a quote: what the client gets (the quote, reminders, the
// acceptance confirmation) and what Henry gets (first view, changes
// requested, accepted, payment). Pure functions: the dashboard's Send dialog
// shows the exact email the Edge Functions send.
//
// HTML for email clients (tables and inline styles) plus a plain text
// version. Everything a person typed is escaped.

export const PAGE_URL = "https://cyberx.la/proposal/";
export const FROM_ADDRESS = "quotes@notify.cyberx.la";
export const DEFAULT_CONTACT = "henry@cyberx.la";

export type MailSettings = { notify_email: string; reply_to: string; from_name: string; stripe_mode: "off" | "test" | "live" };

/** What the database hands over about a quote (proposal_api.context). */
export type MailContext = {
  id: string;
  number: string;
  version: number;
  status: string;
  title: string;
  company: string;
  first_name: string;
  to: string | null;
  to_name: string | null;
  cc: string[];
  valid_until: string;
  token: string;
  subject: string | null;
  note: string | null;
  settings: MailSettings;
};

export type Email = { subject: string; html: string; text: string };

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const quoteLink = (token: string, extra = "") => `${PAGE_URL}?k=${encodeURIComponent(token)}${extra}`;
/** "Henry at cyberxLA <quotes@notify.cyberx.la>", with nothing in the name that could break the header. */
export const fromHeader = (name: string) => `${(name || "cyberxLA").replace(/[<>"\r\n,;]/g, "").trim() || "cyberxLA"} <${FROM_ADDRESS}>`;
/** Subjects are one line, whatever was typed. */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);

export function longDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? "");
  if (!m) return day ?? "";
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export const usd = (c: number) => {
  const a = Math.abs(Math.round(c)), r = a % 100;
  return `${c < 0 ? "−" : ""}$${Math.floor(a / 100).toLocaleString("en-US")}${r ? `.${String(r).padStart(2, "0")}` : ""}`;
};

/** "$5,900", "$350/mo", or "$4,200 plus $350/mo", from cents. */
export const amountText = (once: number, monthly: number) =>
  monthly > 0 ? (once > 0 ? `${usd(once)} plus ${usd(monthly)}/mo` : `${usd(monthly)}/mo`) : usd(once);

export const defaultSubject = (number: string, title: string) => oneLine(`Your quote ${number}: ${title}`);
export const defaultNote = (firstName: string, title: string) =>
  `Hi ${firstName || "there"},\n\nHere's your quote for ${title}. You can pick what fits, add anything extra, and accept it online.\n\nAny questions, just reply to this email.`;

// ---------------------------------------------------------------------------
// The shell every email shares: the wordmark on a dark bar, a light card.
// ---------------------------------------------------------------------------
type Block = string;
const P = "margin:0 0 14px;font-size:16px;line-height:1.55;color:#111315";
const SMALL = "margin:0 0 8px;font-size:13px;line-height:1.5;color:#565B60";

export function paragraphs(text: string): Block {
  return text.split(/\n{2,}/).map((p) => `<p style="${P}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}
export function button(href: string, label: string): Block {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 18px"><tr><td style="background:#D6FF3F;border-radius:999px">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#111315;text-decoration:none;border-radius:999px">${esc(label)}</a></td></tr></table>`;
}
export function rows(items: [string, string][], totalFrom = items.length): Block {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;border-collapse:collapse;font-size:15px">` +
    items.map(([k, v], i) => `<tr><td style="padding:8px 0;border-top:1px solid #dcdfdd;${i >= totalFrom ? "font-weight:700;" : ""}">${esc(k)}</td><td align="right" style="padding:8px 0;border-top:1px solid #dcdfdd;font-weight:700;white-space:nowrap">${esc(v)}</td></tr>`).join("") +
    `</table>`;
}

export function shell(o: { subject: string; preheader: string; eyebrow: string; heading: string; body: Block; footer: string; banner?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(o.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#E3E7E6;font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif;color:#111315">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E3E7E6"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">` +
    (o.banner ? `<tr><td style="background:#fab219;color:#111315;border-radius:12px;padding:12px 16px;font-size:14px;font-weight:600">${esc(o.banner)}</td></tr><tr><td style="height:12px"></td></tr>` : "") +
    `<tr><td style="background:#111315;border-radius:18px 18px 0 0;padding:20px 28px"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#E3E7E6">cyber<span style="color:#D6FF3F">x</span>LA</span></td></tr>` +
    `<tr><td style="background:#FBFAF6;padding:28px;border-radius:0 0 18px 18px">` +
    `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#565B60">${esc(o.eyebrow)}</p>` +
    `<h1 style="margin:0 0 18px;font-size:26px;line-height:1.15;letter-spacing:-0.02em;color:#111315">${esc(o.heading)}</h1>${o.body}</td></tr>` +
    `<tr><td style="padding:16px 8px;font-size:13px;line-height:1.5;color:#565B60;text-align:center">${o.footer}</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

const footerFor = (contact: string) => `cyberxLA, Los Angeles. Questions? Reply to this email or write to <a href="mailto:${esc(contact)}" style="color:#111315">${esc(contact)}</a>.`;

// ---------------------------------------------------------------------------
// To the client
// ---------------------------------------------------------------------------
export type QuoteMailKind = "send" | "resend" | "reminder_unviewed" | "reminder_expiring";

/** The quote itself (Send now, Send later, Resend) and the follow ups. `test` marks a copy for Henry. */
export function quoteEmail(c: MailContext, kind: QuoteMailKind, test = false): Email {
  const link = quoteLink(c.token);
  const valid = longDate(c.valid_until);
  const contact = c.settings.reply_to || DEFAULT_CONTACT;
  let subject = c.subject ? oneLine(c.subject) : defaultSubject(c.number, c.title);
  let note = c.note ?? defaultNote(c.first_name, c.title);
  if (kind === "reminder_unviewed") {
    subject = `Reminder: your quote ${c.number}, ${c.title}`;
    note = `Hi ${c.first_name},\n\nJust making sure this reached you. Your quote for ${c.title} is ready to look over whenever you have a minute.\n\nAny questions, just reply to this email.`;
  } else if (kind === "reminder_expiring") {
    subject = `Your quote ${c.number} is valid until ${valid}`;
    note = `Hi ${c.first_name},\n\nA quick heads up: your quote for ${c.title} is valid until ${valid}. If you'd like to go ahead, you can accept it online in a couple of minutes. If anything needs to change, reply and I'll update it.`;
  }
  if (test) subject = `[Test] ${subject}`;
  const banner = test ? `Test email. This is what ${c.to || "the client"} will get.${c.version === 0 ? " The link works once the quote is sent." : ""}` : undefined;
  const html = shell({
    subject, preheader: `Quote ${c.number} for ${c.company}, valid until ${valid}.`, eyebrow: `Quote ${c.number}`, heading: c.title, banner,
    body: paragraphs(note) + button(link, "View your quote") +
      `<p style="${SMALL}">Quote ${esc(c.number)} for ${esc(c.company)}, valid until ${esc(valid)}.</p>` +
      `<p style="${SMALL}">If the button doesn't work, copy this link into your browser:<br><a href="${esc(link)}" style="color:#111315;word-break:break-all">${esc(link)}</a></p>`,
    footer: footerFor(contact),
  });
  const text = [banner ? `${banner}\n` : "", note, "", `View your quote: ${link}`, "", `Quote ${c.number} for ${c.company}, valid until ${valid}.`, "", `cyberxLA, Los Angeles. Questions? Reply to this email or write to ${contact}.`].join("\n");
  return { subject, html, text };
}

export type AcceptedSummary = {
  tier_name: string;
  lines: { name: string; billing: "once" | "monthly"; price: number }[];
  discount: { label: string; once: number; monthly: number } | null;
  once_total: number;
  monthly_total: number;
  due_now: number;
  deposit: "deposit" | "full" | "none";
  signer: string;
  /** Show a Pay button (Stripe connected and something due). */
  pay: boolean;
};

function selectionRows(s: AcceptedSummary): [string, string][] {
  const r: [string, string][] = s.lines.map((l) => [l.name, `${usd(l.price)}${l.billing === "monthly" ? "/mo" : ""}`]);
  if (s.discount?.once) r.push([s.discount.label, `−${usd(s.discount.once)}`]);
  if (s.discount?.monthly) r.push([s.discount.label, `−${usd(s.discount.monthly)}/mo`]);
  return r;
}
function totalRows(s: AcceptedSummary): [string, string][] {
  // A monthly only selection has no one time total to show.
  const r: [string, string][] = s.once_total > 0 || s.monthly_total === 0 ? [["One time total", usd(s.once_total)]] : [];
  if (s.monthly_total > 0) r.push(["Monthly", `${usd(s.monthly_total)}/mo`]);
  if (s.due_now > 0) r.push([s.deposit === "full" ? "Due now" : "Deposit due", usd(s.due_now)]);
  return r;
}

/** The client's confirmation after accepting, with Pay when Stripe is connected. */
export function acceptedEmail(c: MailContext, s: AcceptedSummary): Email {
  const link = quoteLink(c.token);
  const contact = c.settings.reply_to || DEFAULT_CONTACT;
  const subject = `Accepted: quote ${c.number}, ${c.title}`;
  const sel = selectionRows(s), tot = totalRows(s);
  const payLine = s.due_now <= 0 ? "" : s.pay ? `You can pay the ${s.deposit === "full" ? "total" : "deposit"} of ${usd(s.due_now)} securely by card.` : `We'll send you an invoice for the ${s.deposit === "full" ? "total" : "deposit"} of ${usd(s.due_now)}.`;
  const intro = `Thank you, ${s.signer.split(/\s+/)[0] || "and welcome"}. Your quote is accepted, and we'll be in touch shortly to schedule the work. Here's what you accepted:`;
  const html = shell({
    subject, preheader: `Quote ${c.number} accepted: ${s.tier_name}, ${amountText(s.once_total, s.monthly_total)}.`, eyebrow: `Quote ${c.number} accepted`, heading: c.title,
    body: paragraphs(intro) + rows([...sel, ...tot], sel.length) + (payLine ? paragraphs(payLine) : "") +
      (s.pay && s.due_now > 0 ? button(quoteLink(c.token, "&pay=1"), s.deposit === "full" ? "Pay now" : "Pay deposit") : button(link, "View your quote")) +
      (s.pay && s.due_now > 0 ? `<p style="${SMALL}"><a href="${esc(link)}" style="color:#111315">View your accepted quote</a></p>` : ""),
    footer: footerFor(contact),
  });
  const text = [intro, "", ...sel.map(([k, v]) => `${k}: ${v}`), ...tot.map(([k, v]) => `${k}: ${v}`), "", payLine,
    s.pay && s.due_now > 0 ? `Pay: ${quoteLink(c.token, "&pay=1")}` : "", `Your quote: ${link}`, "", `cyberxLA, Los Angeles. Questions? Reply to this email or write to ${contact}.`].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// To Henry
// ---------------------------------------------------------------------------
export type NoticeKind = "first_view" | "changes" | "accepted" | "payment" | "email_failed";

export function ownerNotice(kind: NoticeKind, c: MailContext, detail: Record<string, unknown> = {}, adminUrl = "https://admin.cyberx.la/"): Email {
  const who = c.company || "A client";
  const open = `${adminUrl}#/quotes/${c.id}`;
  let subject: string, lines: string[];
  switch (kind) {
    case "first_view":
      subject = `${who} opened quote ${c.number}`;
      lines = [`${who} opened ${c.number}, ${c.title}, for the first time.`];
      break;
    case "changes":
      subject = `${who} asked for changes to ${c.number}`;
      lines = [`${String(detail.name ?? "The client")} (${String(detail.email ?? "no email")}) asked for ${detail.expired ? "an updated quote" : "changes"} on ${c.number}, ${c.title}:`, "", String(detail.message ?? "")];
      break;
    case "accepted":
      subject = `${who} accepted ${c.number}: ${amountText(Number(detail.once_cents ?? 0), Number(detail.monthly_cents ?? 0))}`;
      lines = [`${String(detail.by ?? "The client")} accepted ${c.number}, ${c.title}.`, "", `Selection: ${String(detail.selection ?? "")}`,
        Number(detail.once_cents ?? 0) > 0 || !(Number(detail.monthly_cents ?? 0) > 0) ? `One time total: ${usd(Number(detail.once_cents ?? 0))}` : "",
        Number(detail.monthly_cents ?? 0) > 0 ? `Monthly: ${usd(Number(detail.monthly_cents))}/mo` : "", Number(detail.due_cents ?? 0) > 0 ? `Due now: ${usd(Number(detail.due_cents))}` : ""].filter(Boolean);
      break;
    case "payment":
      subject = `Payment received for ${c.number}: ${usd(Number(detail.amount_cents ?? 0))}`;
      lines = [`${who} paid ${usd(Number(detail.amount_cents ?? 0))} (${String(detail.kind ?? "payment")}) for ${c.number}, ${c.title}.${detail.livemode === false ? " Stripe test mode." : ""}`];
      break;
    default:
      subject = `Email for ${c.number} didn't send`;
      lines = [`The email for ${c.number}, ${c.title}, didn't go out: ${String(detail.error ?? "unknown error")}.`];
  }
  const text = [...lines, "", `Open it in the admin: ${open}`].join("\n");
  const html = shell({ subject, preheader: lines[0] ?? subject, eyebrow: `Quote ${c.number}`, heading: subject, body: paragraphs(lines.join("\n")) + button(open, "Open in the admin"), footer: "Sent to you by the cyberxLA admin." });
  return { subject: oneLine(subject), html, text };
}
