// Outgoing quotes (proposals): the document format, its checks, the totals
// math, and placeholders. Pure functions with no I/O, shared by the dashboard
// (editor and live preview), the Edge Functions (acceptance, emails, Stripe)
// and the unit tests (tests/proposal.test.ts).
//
// The public page at cyberx.la/proposal/ (cyberxla-website, proposal.js) has
// its own copy of totals() in plain JavaScript. Keep the two in step: the
// acceptance function recomputes every total here and refuses an acceptance
// whose total doesn't match what the page showed.
//
// Money is in dollars with up to 2 decimals in the document; all math is in
// whole cents so rounding can never drift.

export type Discount = { kind: "percent" | "amount"; value: number } | null;

export type Tier = {
  key: string;
  name: string;
  /** One time price, before any discount on this tier. */
  price: number;
  discount: Discount;
  /** Monthly price, or null for none. */
  monthly: number | null;
  monthly_discount: Discount;
  summary: string;
};

/** A comparison cell: true is a check, false is not included, text is included with that wording. */
export type Cell = boolean | string;
export type Row = { key: string; label: string; explain: string; values: Record<string, Cell> };

export type AddonState = "available" | "included" | "unavailable";
export type Addon = {
  key: string;
  name: string;
  description: string;
  price: number;
  billing: "once" | "monthly";
  discount: Discount;
  tiers: Record<string, AddonState>;
};

/** A note in the summary's fine print. Shown for the listed tiers (all when empty), and only when its add on is selected or included. */
export type Fine = { key: string; text: string; tiers: string[]; addon: string | null };

export type WholeDiscount = { kind: "percent" | "amount"; value: number; label: string; applies_to: "once" | "monthly" } | null;
export type Payment = { mode: "none" | "deposit" | "full"; deposit_kind: "percent" | "amount"; deposit_value: number };

export type ProposalDoc = {
  v: 1;
  intro: string;
  tiers: Tier[];
  recommended: string | null;
  default_tier: string;
  rows: Row[];
  addons: Addon[];
  discount: WholeDiscount;
  payment: Payment;
  fine_print: Fine[];
  /** Link to cyberx.la/terms/ under the summary. */
  terms: boolean;
};

/** Internal only, never sent to the public page: what each item costs you, and which catalog service it came from. */
export type ProposalInternal = {
  costs?: Record<string, number>;
  links?: Record<string, string>;
};

export const LIMITS = {
  title: 120, intro: 1500, tiers: 6, tierName: 60, summary: 240, rows: 80, rowLabel: 120, explain: 1200, cellText: 60,
  addons: 30, addonName: 120, addonDesc: 500, fine: 12, fineText: 400, discountLabel: 60,
  price: 10_000_000, monthly: 1_000_000, addonPrice: 1_000_000,
} as const;

export const KEY = /^[a-z0-9]{1,24}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;
const ONE_LINE = /[\u0000-\u001F\u007F\u2028\u2029]/;

export class BadDoc extends Error {}

// ---------------------------------------------------------------------------
// Checking a document. The same limits are enforced by the database
// (public.proposal_doc_ok), so this is about friendly messages, not trust.
// ---------------------------------------------------------------------------

function str(v: unknown, where: string, max: number, opts: { required?: boolean; multiline?: boolean } = {}): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new BadDoc(`${where} must be text`);
  const s = v.normalize("NFC").trim();
  if (opts.required && !s) throw new BadDoc(`${where} is required`);
  if (s.length > max) throw new BadDoc(`${where} is longer than ${max} characters`);
  if ((opts.multiline ? CONTROL : ONE_LINE).test(s)) throw new BadDoc(`${where} has characters that aren't allowed`);
  return s;
}

function amount(v: unknown, where: string, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new BadDoc(`${where} must be a price from 0 to ${max.toLocaleString("en-US")}`);
  return Math.round(n * 100) / 100;
}

function discount(v: unknown, where: string): Discount {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new BadDoc(`${where} is not a discount`);
  const d = v as Record<string, unknown>;
  if (d.kind !== "percent" && d.kind !== "amount") throw new BadDoc(`${where} must be a percent or an amount`);
  const value = amount(d.value, where, d.kind === "percent" ? 100 : LIMITS.price);
  return { kind: d.kind, value };
}

function key(v: unknown, where: string, seen: Set<string>): string {
  if (typeof v !== "string" || !KEY.test(v)) throw new BadDoc(`${where} has a bad key`);
  if (seen.has(v)) throw new BadDoc(`${where} repeats a key`);
  seen.add(v);
  return v;
}

const list = (v: unknown, where: string, max: number, min = 0): unknown[] => {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v)) throw new BadDoc(`${where} must be a list`);
  if (v.length < min) throw new BadDoc(`${where} needs at least ${min}`);
  if (v.length > max) throw new BadDoc(`${where} can have at most ${max}`);
  return v;
};

const obj = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadDoc(`${where} is missing`);
  return v as Record<string, unknown>;
};

/** A clean copy of a document: known fields only, trimmed, in range. Throws BadDoc with a message that says what to fix. */
export function normalizeDoc(input: unknown): ProposalDoc {
  const d = obj(input, "The quote");
  const tierKeys = new Set<string>();
  const tiers: Tier[] = list(d.tiers, "Tiers", LIMITS.tiers, 1).map((raw, i) => {
    const t = obj(raw, `Tier ${i + 1}`);
    const name = str(t.name, `Tier ${i + 1} name`, LIMITS.tierName, { required: true });
    return {
      key: key(t.key, `Tier ${name}`, tierKeys),
      name,
      price: amount(t.price, `${name} price`, LIMITS.price),
      discount: discount(t.discount, `${name} discount`),
      monthly: t.monthly === null || t.monthly === undefined || t.monthly === "" ? null : amount(t.monthly, `${name} monthly price`, LIMITS.monthly),
      monthly_discount: discount(t.monthly_discount, `${name} monthly discount`),
      summary: str(t.summary, `${name} summary`, LIMITS.summary),
    };
  });
  const keys = tiers.map((t) => t.key);

  const rowKeys = new Set<string>();
  const rows: Row[] = list(d.rows, "Rows", LIMITS.rows).map((raw, i) => {
    const r = obj(raw, `Row ${i + 1}`);
    const label = str(r.label, `Row ${i + 1} label`, LIMITS.rowLabel, { required: true });
    const vals = r.values && typeof r.values === "object" && !Array.isArray(r.values) ? r.values as Record<string, unknown> : {};
    const values: Record<string, Cell> = {};
    for (const k of keys) {
      const v = vals[k];
      if (typeof v === "string") {
        const s = str(v, `${label} for ${tiers.find((t) => t.key === k)!.name}`, LIMITS.cellText);
        values[k] = s || true;
      } else values[k] = v === true;
    }
    return { key: key(r.key, `Row ${label}`, rowKeys), label, explain: str(r.explain, `${label} explanation`, LIMITS.explain, { multiline: true }), values };
  });

  const addonKeys = new Set<string>();
  const addons: Addon[] = list(d.addons, "Add ons", LIMITS.addons).map((raw, i) => {
    const a = obj(raw, `Add on ${i + 1}`);
    const name = str(a.name, `Add on ${i + 1} name`, LIMITS.addonName, { required: true });
    if (a.billing !== "once" && a.billing !== "monthly") throw new BadDoc(`${name} must be one time or monthly`);
    const st = a.tiers && typeof a.tiers === "object" && !Array.isArray(a.tiers) ? a.tiers as Record<string, unknown> : {};
    const states: Record<string, AddonState> = {};
    for (const k of keys) states[k] = st[k] === "included" || st[k] === "unavailable" ? st[k] as AddonState : "available";
    return {
      key: key(a.key, `Add on ${name}`, addonKeys), name,
      description: str(a.description, `${name} description`, LIMITS.addonDesc, { multiline: true }),
      price: amount(a.price, `${name} price`, LIMITS.addonPrice), billing: a.billing,
      discount: discount(a.discount, `${name} discount`), tiers: states,
    };
  });

  const fineKeys = new Set<string>();
  const fine_print: Fine[] = list(d.fine_print, "Fine print", LIMITS.fine).map((raw, i) => {
    const f = obj(raw, `Note ${i + 1}`);
    const t = list(f.tiers, `Note ${i + 1} tiers`, LIMITS.tiers).filter((k): k is string => typeof k === "string" && keys.includes(k));
    const addon = typeof f.addon === "string" && addonKeys.has(f.addon) ? f.addon : null;
    return { key: key(f.key, `Note ${i + 1}`, fineKeys), text: str(f.text, `Note ${i + 1}`, LIMITS.fineText, { required: true }), tiers: [...new Set(t)], addon };
  });

  let whole: WholeDiscount = null;
  if (d.discount) {
    const w = obj(d.discount, "The discount");
    const base = discount(w, "The quote discount");
    if (base && base.value > 0) {
      whole = { ...base, label: str(w.label, "Discount label", LIMITS.discountLabel) || "Discount", applies_to: w.applies_to === "monthly" ? "monthly" : "once" };
    }
  }

  const p = d.payment && typeof d.payment === "object" ? d.payment as Record<string, unknown> : {};
  const mode = p.mode === "deposit" || p.mode === "full" ? p.mode : "none";
  const deposit_kind = p.deposit_kind === "amount" ? "amount" : "percent";
  const deposit_value = amount(p.deposit_value ?? 0, "Deposit", deposit_kind === "percent" ? 100 : LIMITS.price);
  if (mode === "deposit" && deposit_value <= 0) throw new BadDoc("Set the deposit, or turn the deposit off");

  const recommended = typeof d.recommended === "string" && keys.includes(d.recommended) ? d.recommended : null;
  const default_tier = typeof d.default_tier === "string" && keys.includes(d.default_tier) ? d.default_tier : (recommended ?? keys[0]!);

  return {
    v: 1, intro: str(d.intro, "Intro", LIMITS.intro, { multiline: true }),
    tiers, recommended, default_tier, rows, addons, discount: whole,
    payment: { mode, deposit_kind, deposit_value }, fine_print, terms: d.terms !== false,
  };
}

/** A document's first problem in words, or null when it's fine. */
export function docProblem(input: unknown): string | null {
  try {
    normalizeDoc(input);
    return null;
  } catch (e) {
    if (e instanceof BadDoc) return e.message;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export const cents = (n: number) => Math.round(n * 100);

/** How much a discount takes off a price in cents (never more than the price). */
export function discountCents(base: number, d: Discount | WholeDiscount): number {
  if (!d || base <= 0) return 0;
  const off = d.kind === "percent" ? Math.round((base * Math.min(100, Math.max(0, d.value))) / 100) : cents(d.value);
  return Math.max(0, Math.min(base, off));
}

export type Line = {
  key: string;
  name: string;
  billing: "once" | "monthly";
  /** Before this item's discount. */
  list: number;
  /** After this item's discount: what the page shows on the line. */
  price: number;
  /** After the whole quote discount is shared out over the lines (for projects and invoices). */
  net: number;
  kind: "tier" | "addon";
};

export type Totals = {
  tier: string;
  addons: string[];
  lines: Line[];
  /** Sums before and after item discounts, in cents. */
  once_list: number;
  once_subtotal: number;
  monthly_list: number;
  monthly_subtotal: number;
  /** The whole quote discount in cents. */
  discount_once: number;
  discount_monthly: number;
  once_total: number;
  monthly_total: number;
  /** What all discounts save, in cents. */
  savings_once: number;
  savings_monthly: number;
  /** Due when the quote is accepted (deposit or full), in cents; 0 when payment is off. */
  due_now: number;
};

/** Which add ons can be ticked on a tier (available), are already in it (included), or neither. */
export function addonsFor(doc: Pick<ProposalDoc, "addons">, tier: string) {
  return {
    available: doc.addons.filter((a) => (a.tiers[tier] ?? "available") === "available"),
    included: doc.addons.filter((a) => a.tiers[tier] === "included"),
  };
}

/** The totals for a selection. Unknown tiers fall back to the default; add ons that aren't available on the tier are dropped. */
export function totals(doc: ProposalDoc, tierKey: string, addonKeys: string[]): Totals {
  const tier = doc.tiers.find((t) => t.key === tierKey) ?? doc.tiers.find((t) => t.key === doc.default_tier) ?? doc.tiers[0]!;
  const picked = addonsFor(doc, tier.key).available.filter((a) => addonKeys.includes(a.key));
  const lines: Line[] = [];
  const push = (l: Omit<Line, "net">) => lines.push({ ...l, net: l.price });
  const tl = cents(tier.price);
  // One tier: its own name. Several: "Pro tier", like the page's summary.
  const tierName = doc.tiers.length > 1 ? `${tier.name} tier` : tier.name;
  push({ key: tier.key, name: tierName, billing: "once", list: tl, price: tl - discountCents(tl, tier.discount), kind: "tier" });
  if (tier.monthly !== null && tier.monthly > 0) {
    const ml = cents(tier.monthly);
    push({ key: `${tier.key}:monthly`, name: `${tier.name}, monthly`, billing: "monthly", list: ml, price: ml - discountCents(ml, tier.monthly_discount), kind: "tier" });
  }
  for (const a of picked) {
    const al = cents(a.price);
    push({ key: a.key, name: a.name, billing: a.billing, list: al, price: al - discountCents(al, a.discount), kind: "addon" });
  }
  const sum = (b: "once" | "monthly", f: "list" | "price") => lines.filter((l) => l.billing === b).reduce((s, l) => s + l[f], 0);
  const once_list = sum("once", "list"), once_subtotal = sum("once", "price");
  const monthly_list = sum("monthly", "list"), monthly_subtotal = sum("monthly", "price");
  const w = doc.discount;
  const discount_once = w && w.applies_to === "once" ? discountCents(once_subtotal, w) : 0;
  const discount_monthly = w && w.applies_to === "monthly" ? discountCents(monthly_subtotal, w) : 0;

  // Share the whole quote discount over the lines in order, so each line's net
  // adds up to the total (a project line can't be negative).
  for (const [b, off] of [["once", discount_once], ["monthly", discount_monthly]] as const) {
    let left = off;
    for (const l of lines) {
      if (l.billing !== b || left <= 0) continue;
      const take = Math.min(l.net, left);
      l.net -= take;
      left -= take;
    }
  }

  const once_total = once_subtotal - discount_once;
  const monthly_total = monthly_subtotal - discount_monthly;
  const p = doc.payment;
  const due_now = p.mode === "full" ? once_total
    : p.mode === "deposit" ? (p.deposit_kind === "percent" ? Math.round((once_total * Math.min(100, p.deposit_value)) / 100) : Math.min(once_total, cents(p.deposit_value)))
    : 0;
  return {
    tier: tier.key, addons: picked.map((a) => a.key), lines,
    once_list, once_subtotal, monthly_list, monthly_subtotal, discount_once, discount_monthly,
    once_total, monthly_total, savings_once: once_list - once_total, savings_monthly: monthly_list - monthly_total, due_now,
  };
}

/** Margin per tier from the internal costs: the tier's own cost plus the cost of every row it includes. */
export function tierMargin(doc: ProposalDoc, internal: ProposalInternal, tierKey: string) {
  const costs = internal.costs ?? {};
  const t = totals(doc, tierKey, []);
  const cost = cents(costs[`tier:${tierKey}`] ?? 0)
    + doc.rows.filter((r) => r.values[tierKey] !== false && r.values[tierKey] !== undefined).reduce((s, r) => s + cents(costs[`row:${r.key}`] ?? 0), 0)
    + addonsFor(doc, tierKey).included.reduce((s, a) => s + cents(costs[`addon:${a.key}`] ?? 0), 0);
  const revenue = t.once_total;
  return { revenue, cost, margin: revenue - cost, pct: revenue > 0 ? (revenue - cost) / revenue : null };
}

// ---------------------------------------------------------------------------
// Placeholders: {company}, {contact_first_name}, {quote_number}, {valid_until}
// ---------------------------------------------------------------------------

export const PLACEHOLDERS = ["company", "contact_first_name", "quote_number", "valid_until"] as const;
export type Vars = Record<(typeof PLACEHOLDERS)[number], string>;

export function fill(text: string, vars: Vars): string {
  return text.replace(/\{(company|contact_first_name|quote_number|valid_until)\}/g, (_, k: keyof Vars) => vars[k]);
}

/** Every text in the document with its placeholders filled in (the database does the same when a version is sent). */
export function resolveDoc(doc: ProposalDoc, vars: Vars): ProposalDoc {
  const f = (s: string) => fill(s, vars);
  return {
    ...doc,
    intro: f(doc.intro),
    tiers: doc.tiers.map((t) => ({ ...t, name: f(t.name), summary: f(t.summary) })),
    rows: doc.rows.map((r) => ({ ...r, label: f(r.label), explain: f(r.explain), values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, typeof v === "string" ? f(v) : v])) })),
    addons: doc.addons.map((a) => ({ ...a, name: f(a.name), description: f(a.description) })),
    discount: doc.discount ? { ...doc.discount, label: f(doc.discount.label) } : null,
    fine_print: doc.fine_print.map((n) => ({ ...n, text: f(n.text) })),
  };
}

export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";
export const quoteNumber = (n: number) => `Q${n}`;

/** "November 17, 2026" from "2026-11-17". */
export function longDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "$4,200" or "$4,200.50", from cents. */
export function usd(c: number): string {
  const neg = c < 0, a = Math.abs(c);
  const whole = Math.floor(a / 100).toLocaleString("en-US"), rest = a % 100;
  return `${neg ? "−" : ""}$${whole}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

export function varsFor(p: { number: number; company: string | null; contact_name: string | null; valid_until: string }): Vars {
  return {
    company: (p.company ?? "").trim() || (p.contact_name ?? "").trim() || "your team",
    contact_first_name: firstName(p.contact_name) || "there",
    quote_number: quoteNumber(p.number),
    valid_until: longDate(p.valid_until),
  };
}

// ---------------------------------------------------------------------------
// What the public page renders (from the database, or from the editor's preview)
// ---------------------------------------------------------------------------

export type PageHeader = {
  number: string;
  version: number;
  title: string;
  prepared_for: string;
  prepared_on: string;
  valid_until: string;
};

export type PageModel = PageHeader & {
  ok: true;
  state: "open" | "viewed" | "changes_requested" | "accepted";
  doc: ProposalDoc;
  contact_email: string;
  /** Stripe: off until it's connected. */
  payments: "off" | "test" | "live";
  accepted: null | { at: string; by: string; tier: string; addons: string[]; once_total: number; monthly_total: number; due_now: number; paid: number };
  preview?: boolean;
};

/** A blank starting document with one tier. */
export function blankDoc(): ProposalDoc {
  return {
    v: 1, intro: "", tiers: [{ key: "base", name: "Standard", price: 0, discount: null, monthly: null, monthly_discount: null, summary: "" }],
    recommended: null, default_tier: "base", rows: [], addons: [], discount: null,
    payment: { mode: "none", deposit_kind: "percent", deposit_value: 50 }, fine_print: [], terms: true,
  };
}

/** A new random key that isn't used yet in the document. */
export function newKey(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    const k = "k" + Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0");
    if (!used.has(k)) return k;
  }
}
