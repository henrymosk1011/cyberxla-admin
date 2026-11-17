// Request checks for quote-public (the client's Accept, Request changes and
// Pay buttons), kept apart from the HTTP handler so they can be tested
// (tests/quote-public.test.ts). Totals are recomputed here from the version
// the client saw; the page's totals are only compared, never trusted.
import { addonsFor, totals, type ProposalDoc, type Totals } from "../_shared/proposal.ts";
import type { AcceptedSummary } from "../_shared/emails.ts";

export const ALLOWED_ORIGINS = new Set(["https://cyberx.la", "https://www.cyberx.la"]);
export const TURNSTILE_HOSTNAMES = new Set(["cyberx.la", "www.cyberx.la"]);
export const MAX_BODY_BYTES = 8 * 1024;
export const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const KEY = /^[a-z0-9]{1,24}$/;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
// Line and paragraph separators, built from char codes so they can never end up raw in a regex literal.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LINE = new RegExp(`[\\u0000-\\u001F\\u007F${SEPARATORS}<>]`);
const TEXT = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F${SEPARATORS}]`);

export class BadRequest extends Error {}

function text(v: unknown, field: string, max: number, required: boolean, multiline = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new BadRequest(field);
  const s = v.normalize("NFC").trim();
  if (required && !s) throw new BadRequest(field);
  if (s.length > max || (multiline ? TEXT : LINE).test(s)) throw new BadRequest(field);
  return s;
}
const int = (v: unknown, field: string) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) throw new BadRequest(field);
  return v;
};

export type Accept = {
  action: "accept"; token: string; version: number; turnstile: string; tier: string; addons: string[];
  expected_once: number; expected_monthly: number; name: string; title: string; email: string; signature: string;
};
export type Changes = { action: "changes"; token: string; turnstile: string; name: string; email: string; message: string };
export type Pay = { action: "pay"; token: string };

/** One request from the quote page, or BadRequest naming the field. */
export function parseRequest(body: unknown): Accept | Changes | Pay {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (typeof b.token !== "string" || !TOKEN.test(b.token)) throw new BadRequest("token");
  // A hidden field real visitors never fill in.
  if (b.website !== undefined && b.website !== "") throw new BadRequest("hp");
  if (b.action === "pay") return { action: "pay", token: b.token };
  const turnstile = text(b.turnstileToken, "turnstileToken", 2048, true);
  if (b.action === "changes") {
    const email = text(b.email, "email", 254, true).toLowerCase();
    if (!EMAIL.test(email)) throw new BadRequest("email");
    return { action: "changes", token: b.token, turnstile, name: text(b.name, "name", 120, true), email, message: text(b.message, "message", 2000, true, true) };
  }
  if (b.action !== "accept") throw new BadRequest("action");
  if (b.agree !== true) throw new BadRequest("agree");
  const email = text(b.email, "email", 254, true).toLowerCase();
  if (!EMAIL.test(email)) throw new BadRequest("email");
  if (typeof b.tier !== "string" || !KEY.test(b.tier)) throw new BadRequest("tier");
  if (!Array.isArray(b.addons) || b.addons.length > 30 || b.addons.some((a) => typeof a !== "string" || !KEY.test(a)) || new Set(b.addons).size !== b.addons.length) throw new BadRequest("addons");
  if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw new BadRequest("version");
  return {
    action: "accept", token: b.token, version: b.version, turnstile, tier: b.tier, addons: b.addons as string[],
    expected_once: int(b.expected_once, "expected_once"), expected_monthly: int(b.expected_monthly, "expected_monthly"),
    name: text(b.name, "name", 120, true), title: text(b.title, "title", 120, false), email, signature: text(b.signature, "signature", 120, true),
  };
}

export class Mismatch extends Error {}

/**
 * The totals for what the client picked, from the version they saw. Refuses a
 * tier or add on that isn't offered, and a total that differs from the page's.
 */
export function checkSelection(doc: ProposalDoc, a: Pick<Accept, "tier" | "addons" | "expected_once" | "expected_monthly">): Totals {
  if (!doc.tiers.some((t) => t.key === a.tier)) throw new BadRequest("tier");
  const offered = new Set(addonsFor(doc, a.tier).available.map((x) => x.key));
  if (a.addons.some((k) => !offered.has(k))) throw new BadRequest("addons");
  const t = totals(doc, a.tier, a.addons);
  if (t.once_total !== a.expected_once || t.monthly_total !== a.expected_monthly) throw new Mismatch("total");
  return t;
}

/** What the confirmation email shows. */
export function acceptedSummary(doc: ProposalDoc, t: Totals, signer: string, pay: boolean): AcceptedSummary {
  const w = doc.discount;
  return {
    tier_name: doc.tiers.find((x) => x.key === t.tier)?.name ?? t.tier,
    lines: t.lines.map((l) => ({ name: l.name, billing: l.billing, price: l.price })),
    discount: w && (t.discount_once || t.discount_monthly) ? { label: w.label || "Discount", once: t.discount_once, monthly: t.discount_monthly } : null,
    once_total: t.once_total, monthly_total: t.monthly_total, due_now: t.due_now,
    deposit: doc.payment.mode, signer, pay: pay && t.due_now > 0,
  };
}

/** "Pro, with USB Security Keys" for Henry's email. */
export function selectionText(doc: ProposalDoc, tier: string, addons: string[]): string {
  const name = doc.tiers.find((x) => x.key === tier)?.name ?? tier;
  const names = addons.map((k) => doc.addons.find((a) => a.key === k)?.name ?? k);
  return names.length ? `${name}, with ${names.join(", ")}` : name;
}
