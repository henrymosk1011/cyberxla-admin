// Outgoing quotes in the dashboard: who a quote is for, its totals for lists,
// the model the live preview sends to the quote page, and the lines a project
// gets. The math itself is in supabase/functions/_shared/proposal.ts.
import { BadDoc, normalizeDoc, resolveDoc, totals, usd, varsFor, type PageModel, type ProposalDoc, type Totals } from "../../../supabase/functions/_shared/proposal.ts";
import { quoteLink } from "../../../supabase/functions/_shared/emails.ts";
import type { Client, Lead, ProposalRow, ProposalStatus, QuoteSettings } from "./types.ts";

/** Where the quote page lives. The preview frames it; production is cyberx.la. */
export const PROPOSAL_ORIGIN = ((import.meta.env?.VITE_PROPOSAL_ORIGIN as string | undefined) || "https://cyberx.la").replace(/\/$/, "");
/** The link a client gets (always cyberx.la). */
export const clientLink = (token: string) => quoteLink(token);
/** The same page for you: it doesn't count as a view. */
export const viewAsClient = (token: string) => `${PROPOSAL_ORIGIN}/proposal/?k=${encodeURIComponent(token)}#nocount`;

export const quoteNo = (p: { number: number }) => `Q${p.number}`;

/** Status words for the pill. */
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Draft", scheduled: "Scheduled", sent: "Sent", viewed: "Viewed", changes_requested: "Changes requested",
  accepted: "Accepted", declined: "Declined", expired: "Expired", revoked: "Revoked",
};

/** The status in words: "Published, not emailed" when the link went out without an email. */
export const statusLabel = (p: Pick<ProposalRow, "status" | "link_only">) =>
  p.status === "sent" && p.link_only ? "Published, not emailed" : PROPOSAL_STATUS_LABEL[p.status];

/** Can the client facing document be edited right now? */
export const isEditable = (p: Pick<ProposalRow, "status" | "revising">) => p.status === "draft" || p.status === "scheduled" || p.revising;

export type Owner = { kind: "Client" | "Lead"; label: string; href: string; company: string | null; contact: string | null; email: string | null };
export function ownerOf(p: Pick<ProposalRow, "client_id" | "lead_id">, clients: Client[], leads: Lead[]): Owner | null {
  if (p.client_id) {
    const c = clients.find((x) => x.id === p.client_id);
    return c ? { kind: "Client", label: c.company || c.contact_name || "Client", href: `#/clients/${c.id}`, company: c.company, contact: c.contact_name, email: c.email } : null;
  }
  const l = leads.find((x) => x.id === p.lead_id);
  return l ? { kind: "Lead", label: l.company || l.name, href: `#/leads/${l.id}`, company: l.company, contact: l.name, email: l.email } : null;
}

/** A document that might not be valid yet (mid edit): the checked version, or null. */
export function safeDoc(d: unknown): ProposalDoc | null {
  try {
    return normalizeDoc(d);
  } catch (e) {
    if (e instanceof BadDoc) return null;
    throw e;
  }
}

/** What a quote is worth in a list: the accepted total, or what opens selected (its default tier). */
export function quoteValue(p: Pick<ProposalRow, "status" | "accepted_once" | "accepted_monthly" | "content">): { once: number; monthly: number; accepted: boolean } {
  if (p.status === "accepted" && p.accepted_once !== null) return { once: Math.round(p.accepted_once * 100), monthly: Math.round((p.accepted_monthly ?? 0) * 100), accepted: true };
  const d = safeDoc(p.content);
  if (!d) return { once: 0, monthly: 0, accepted: false };
  const t = totals(d, d.default_tier, []);
  return { once: t.once_total, monthly: t.monthly_total, accepted: false };
}
export const valueText = (v: { once: number; monthly: number }) => (v.monthly ? `${usd(v.once)} + ${usd(v.monthly)}/mo` : usd(v.once));

/** The model the quote page renders, built from the draft exactly as Send would freeze it. */
export function previewModel(o: {
  number: number; version: number; title: string; owner: Owner | null; recipientName: string; preparedOn: string; validUntil: string;
  doc: ProposalDoc; settings: Pick<QuoteSettings, "reply_to" | "stripe_mode"> | null;
}): PageModel {
  const vars = varsFor({ number: o.number, company: o.owner?.company ?? null, contact_name: o.recipientName || o.owner?.contact || null, valid_until: o.validUntil });
  const prepared_for = (o.owner?.company || o.owner?.contact || o.recipientName || "").trim();
  return {
    ok: true, state: "viewed", number: `Q${o.number}`, version: o.version + 1, title: o.title.replace(/\{(company|contact_first_name|quote_number|valid_until)\}/g, (_, k: keyof typeof vars) => vars[k]),
    prepared_for, prepared_on: o.preparedOn, valid_until: o.validUntil, doc: resolveDoc(o.doc, vars),
    contact_email: o.settings?.reply_to ?? "henry@cyberx.la", payments: o.settings?.stripe_mode ?? "off", accepted: null, preview: true,
  };
}

/** The lines a project gets from a selection (cents; the database rounds them to dollars). */
export function projectLines(doc: ProposalDoc, tier: string, addons: string[]): { lines: Totals["lines"]; totals: Totals } {
  const t = totals(doc, tier, addons);
  return { lines: t.lines, totals: t };
}

/** "Pro, with USB Security Keys and Phone Policies" */
export function selectionText(doc: ProposalDoc, tier: string, addons: string[]): string {
  const t = doc.tiers.find((x) => x.key === tier)?.name ?? tier;
  const names = addons.map((k) => doc.addons.find((a) => a.key === k)?.name ?? k);
  return names.length ? `${t}, with ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}` : t;
}

/** Days from one moment to another, rounded to one decimal. */
export const daysBetween = (a: string, b: string) => Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 86400000) * 10) / 10;

/** Quote stats for the Overview: open quotes, sent this month, win rate, average days to accept. */
export function quoteStats(list: ProposalRow[], nowMs = Date.now()) {
  const live = list.filter((p) => !p.archived_at);
  const open = live.filter((p) => ["sent", "viewed", "changes_requested"].includes(p.status));
  const openValue = open.reduce((s, p) => s + quoteValue(p).once, 0);
  const openMonthly = open.reduce((s, p) => s + quoteValue(p).monthly, 0);
  const n = new Date(nowMs);
  const monthStart = new Date(n.getFullYear(), n.getMonth(), 1).getTime();
  const sentThisMonth = live.filter((p) => p.sent_at && new Date(p.sent_at).getTime() >= monthStart).length;
  const decided = live.filter((p) => ["accepted", "declined", "expired"].includes(p.status));
  const won = decided.filter((p) => p.status === "accepted");
  const days = won.filter((p) => p.sent_at && p.accepted_at).map((p) => Math.max(0, daysBetween(p.sent_at!, p.accepted_at!)));
  return {
    open: open.length, openValue, openMonthly, sentThisMonth,
    winRate: decided.length ? won.length / decided.length : null,
    avgDaysToAccept: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
  };
}

/** A timeline entry in words. */
export function describeEvent(e: { kind: string; detail: Record<string, unknown> }): string {
  const d = e.detail ?? {};
  const v = d.version ? ` (version ${d.version})` : "";
  switch (e.kind) {
    case "created": return d.from ? `Created as a copy of ${d.from}` : "Created";
    case "duplicated": return `Copied from ${d.from}`;
    case "edited": return d.revising ? "Revision edited" : "Edited";
    case "sent": return `Sent${v}${d.to ? ` to ${d.to}` : ""}${d.scheduled ? ", on schedule" : ""}${d.emailed === false ? ", link published without an email" : ""}`;
    case "resent": return `Email sent again${Array.isArray(d.to) ? ` to ${(d.to as string[]).join(", ")}` : ""}`;
    case "test_sent": return `Test email sent${Array.isArray(d.to) ? ` to ${(d.to as string[]).join(", ")}` : ""}`;
    case "scheduled": return `Scheduled to send ${d.at ? new Date(String(d.at)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}`;
    case "unscheduled": return "Schedule cancelled";
    case "viewed": return Number(d.count) > 1 ? `Viewed (${d.count} times)` : "Opened by the client for the first time";
    case "reminder": return d.kind === "expiring" ? "Reminder sent: expiring soon" : "Reminder sent: not opened yet";
    case "changes_requested": return `${d.expired ? "Updated quote requested" : "Changes requested"}${d.name ? ` by ${d.name}` : ""}${d.message ? `: “${String(d.message).slice(0, 140)}${String(d.message).length > 140 ? "…" : ""}”` : ""}`;
    case "accepted": return `Accepted${d.by ? ` by ${d.by}` : ""}${d.once_total !== undefined ? `, ${usd(Math.round(Number(d.once_total) * 100))}` : ""}`;
    case "declined": return "Marked declined";
    case "reopened": return "Reopened";
    case "expired": return "Expired";
    case "revoked": return "Link turned off";
    case "link_regenerated": return d.was_revoked ? "New link made, quote back on" : "New link made (the old one stopped working)";
    case "revision_started": return `Revision started${v}`;
    case "revision_discarded": return "Revision discarded";
    case "converted": return "Converted to a project";
    case "payment": return `Payment received${d.amount ? `: ${usd(Math.round(Number(d.amount) * 100))}` : ""}${d.livemode === false ? " (test mode)" : ""}`;
    case "payment_failed": return "A payment didn't go through";
    case "email_failed": return `Email didn't send${d.error ? `: ${d.error}` : ""}`;
    case "extended": return `Valid until changed to ${d.to}`;
    default: return e.kind;
  }
}
