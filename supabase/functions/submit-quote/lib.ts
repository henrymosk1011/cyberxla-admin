// Validation and pricing for submit-quote. Pure functions, no I/O, so they can
// be unit-tested (tests/submit-quote.test.ts).
//
// Services and prices live in the database (public.services, managed from the
// dashboard) and are passed in as a Catalog.

const MIN_MONTHLY = 300;
const SERVER_MULT = 2.5;

export type Unit = "dev" | "mo" | "once" | "devonce";
export type Service = { name: string; price: number; unit: Unit; from?: boolean };
export type Catalog = Record<string, Service>;
export type CatalogCategory = {
  id: string;
  name: string;
  blurb: string;
  services: { id: string; name: string; description: string; price: number; unit: Unit; from: boolean; in_packages: boolean }[];
};

const UNITS = new Set<Unit>(["dev", "mo", "once", "devonce"]);

/** Turn public.service_catalog() output into an id -> service lookup. Skips anything malformed. */
export function catalogFromRpc(data: unknown): Catalog {
  const out: Catalog = Object.create(null);
  if (!Array.isArray(data)) return out;
  for (const cat of data as CatalogCategory[]) {
    for (const s of Array.isArray(cat?.services) ? cat.services : []) {
      const price = Number(s?.price);
      if (typeof s?.id !== "string" || typeof s.name !== "string" || !Number.isFinite(price) || price < 0 || !UNITS.has(s.unit)) continue;
      out[s.id] = { name: s.name, price, unit: s.unit, from: !!s.from };
    }
  }
  return out;
}

export class BadRequest extends Error {}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9+().\-\s x]{0,40}$/i;

function text(v: unknown, field: string, max: number, required: boolean, multiline = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new BadRequest(field);
  const s = v.normalize("NFC").trim();
  if (required && !s) throw new BadRequest(field);
  if (s.length > max) throw new BadRequest(field);
  const forbidden = multiline ? CONTROL_CHARS : /[\u0000-\u001F\u007F\u2028\u2029]/;
  if (forbidden.test(s)) throw new BadRequest(field);
  return s;
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new BadRequest(field);
  return v;
}

export function priceQuote(catalog: Catalog, ids: string[], ws: number, sv: number) {
  const units = ws + sv * SERVER_MULT, devices = ws + sv;
  let monthlyRaw = 0, once = 0;
  const items = ids.map((id) => {
    const s = catalog[id]!;
    const monthly = s.unit === "dev" || s.unit === "mo";
    const cost = s.unit === "dev" ? s.price * units : s.unit === "devonce" ? s.price * devices : s.price;
    if (monthly) monthlyRaw += cost; else once += cost;
    return { id, name: s.name, unit: s.unit, unit_price: s.price, from: !!s.from, kind: monthly ? "monthly" : "once", cost: round2(cost) };
  });
  const monthly = monthlyRaw > 0 ? Math.max(monthlyRaw, MIN_MONTHLY) : 0;
  return {
    items,
    monthly_total: round2(monthly),
    one_time_total: round2(once),
    monthly_minimum_applied: monthlyRaw > 0 && monthlyRaw < MIN_MONTHLY,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseSubmission(body: unknown, catalog: Catalog) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;

  // Honeypot: a hidden field real visitors never fill in.
  if (b.website !== undefined && b.website !== "") throw new BadRequest("hp");

  const token = text(b.turnstileToken, "turnstileToken", 2048, true);
  const name = text(b.name, "name", 120, true);
  const company = text(b.company, "company", 160, false);
  const email = text(b.email, "email", 254, true).toLowerCase();
  if (!EMAIL.test(email)) throw new BadRequest("email");
  const phone = text(b.phone, "phone", 40, false);
  if (!PHONE.test(phone)) throw new BadRequest("phone");
  const message = text(b.message, "message", 2000, false, true);
  const workstations = int(b.workstations, "workstations", 0, 5000);
  const servers = int(b.servers, "servers", 0, 500);

  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > Object.keys(catalog).length) {
    throw new BadRequest("items");
  }
  const ids: string[] = [];
  for (const id of b.items) {
    if (typeof id !== "string" || !Object.hasOwn(catalog, id) || ids.includes(id)) throw new BadRequest("items");
    ids.push(id);
  }

  return { token, lead: { name, company, email, phone, message, workstations, servers }, priced: priceQuote(catalog, ids, workstations, servers) };
}
