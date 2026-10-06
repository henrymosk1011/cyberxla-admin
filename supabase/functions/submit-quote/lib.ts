// Validation and pricing for submit-quote. Pure functions, no I/O, so they can
// be unit-tested (tests/submit-quote.test.ts).
//
// Keep CATALOG in sync with build-your-quote/index.html on the website
// (scripts/check-catalog.mjs compares them).

const MIN_MONTHLY = 300;
const SERVER_MULT = 2.5;

type Unit = "dev" | "mo" | "once" | "devonce";
type Service = { name: string; price: number; unit: Unit; from?: boolean };

export const CATALOG: Record<string, Service> = {
  patching: { name: "Patching", price: 10, unit: "dev" },
  edr: { name: "EDR", price: 8, unit: "dev" },
  ransomware: { name: "Ransomware Protection", price: 5, unit: "dev" },
  encryption: { name: "Disk Encryption", price: 3, unit: "dev" },
  hardening: { name: "Device Hardening", price: 35, unit: "devonce" },
  firewall: { name: "Firewall and Wi-Fi Security", price: 150, unit: "mo" },
  mdr: { name: "24/7 MDR", price: 14, unit: "dev" },
  domain: { name: "Domain Monitoring", price: 49, unit: "mo" },
  darkweb: { name: "Dark Web Monitoring", price: 75, unit: "mo" },
  cloudmon: { name: "Microsoft 365 and Google Monitoring", price: 5, unit: "dev" },
  irretainer: { name: "Incident Response Retainer", price: 400, unit: "mo" },
  irplan: { name: "Incident Response Plan", price: 2500, unit: "once" },
  filtering: { name: "Email Filtering", price: 4, unit: "dev" },
  training: { name: "Phishing Training", price: 3, unit: "dev" },
  dmarc: { name: "SPF, DKIM, and DMARC", price: 750, unit: "once" },
  mfa: { name: "MFA Rollout", price: 50, unit: "devonce" },
  passwords: { name: "Password Manager", price: 6, unit: "dev" },
  access: { name: "Access Reviews", price: 99, unit: "mo" },
  pentest: { name: "Penetration Testing", price: 5000, unit: "once", from: true },
  vuln: { name: "Vulnerability Management", price: 4, unit: "dev" },
  risk: { name: "Security Risk Assessment", price: 3500, unit: "once" },
  surface: { name: "External Attack Surface Review", price: 1800, unit: "once" },
  cloudbackup: { name: "Microsoft 365 and Google Backup", price: 4, unit: "dev" },
  devbackup: { name: "Device and Server Backup", price: 10, unit: "dev" },
  restore: { name: "Restore Testing", price: 150, unit: "mo" },
  drplan: { name: "Disaster Recovery Planning", price: 3000, unit: "once" },
  insurance: { name: "Cyber Insurance Readiness", price: 2500, unit: "once" },
  hipaa: { name: "HIPAA Security Support", price: 400, unit: "mo" },
  policies: { name: "Security Policies", price: 2000, unit: "once" },
  questionnaire: { name: "Client Security Questionnaires", price: 500, unit: "once" },
};

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

export function priceQuote(ids: string[], ws: number, sv: number) {
  const units = ws + sv * SERVER_MULT, devices = ws + sv;
  let monthlyRaw = 0, once = 0;
  const items = ids.map((id) => {
    const s = CATALOG[id]!;
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

export function parseSubmission(body: unknown) {
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

  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > Object.keys(CATALOG).length) {
    throw new BadRequest("items");
  }
  const ids: string[] = [];
  for (const id of b.items) {
    if (typeof id !== "string" || !Object.hasOwn(CATALOG, id) || ids.includes(id)) throw new BadRequest("items");
    ids.push(id);
  }

  return { token, lead: { name, company, email, phone, message, workstations, servers }, priced: priceQuote(ids, workstations, servers) };
}
