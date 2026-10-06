// Sample data for `npm run demo`. Never included in a production build
// (vite.config.ts only aliases $db to this file in demo mode).
import { CATALOG, priceQuote } from "../../../supabase/functions/submit-quote/lib.ts";
import type { AuditEntry, AuthState, ChangeEvent, Db, Lead, LeadStatus, Note, Quote, QuoteStatus } from "./types.ts";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const uuid = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(rand() * 16).toString(16));

const FIRST = ["Maria", "James", "Ana", "David", "Grace", "Luis", "Sarah", "Kevin", "Nina", "Omar", "Rachel", "Tony", "Lena", "Victor", "Priya", "Sam"];
const LAST = ["Garcia", "Kim", "Nguyen", "Hovsepian", "Cohen", "Martinez", "Patel", "Lee", "Brooks", "Avakian", "Reyes", "Shah"];
const BIZ = ["Westside Dental", "Pacific CPA Group", "Silver Lake Law", "Echo Park Realty", "Mid-City Home Health", "Glendale Pediatrics", "Burbank Elevator Co", "Harbor Logistics", "Sunset Fitness", "Valley Insurance Partners", "Pasadena Architects", "Culver Creative", "Koreatown Medical", "Atwater Accounting", "Santa Monica Spine", "Eagle Rock Vet"];
const BUNDLES = [["patching"], ["patching", "edr"], ["patching", "edr", "mdr"], ["patching", "edr", "mdr", "filtering", "training"], ["cloudbackup", "devbackup", "restore"], ["hipaa", "risk", "policies"], ["pentest", "surface"], ["insurance", "mfa", "passwords"], ["dmarc", "filtering"], ["irretainer", "irplan"]];

const now = Date.now();
const leads: Lead[] = [];
const quotes: Quote[] = [];
const notes: Note[] = [];
const audit: AuditEntry[] = [];

for (let i = 0; i < 46; i++) {
  const ageDays = Math.floor(rand() ** 1.6 * 180);
  const created = new Date(now - ageDays * 86400000 - rand() * 86400000);
  const ids = [...new Set([...pick(BUNDLES), ...(rand() < 0.4 ? [pick(Object.keys(CATALOG))] : [])])];
  const ws = pick([5, 8, 10, 12, 15, 20, 25, 35, 50]);
  const sv = pick([0, 0, 1, 1, 2, 3]);
  const priced = priceQuote(ids, ws, sv);
  const status: LeadStatus = ageDays < 6 ? pick(["new", "new", "contacted"] as const)
    : ageDays < 30 ? pick(["new", "contacted", "contacted", "proposal", "proposal", "won"] as const)
    : pick(["contacted", "proposal", "won", "won", "won", "lost", "lost"] as const);
  const first = pick(FIRST), last = pick(LAST), company = BIZ[i % BIZ.length]!;
  const id = uuid();
  const updated = new Date(Math.min(now, created.getTime() + rand() * 20 * 86400000));
  leads.push({
    id, created_at: created.toISOString(), updated_at: updated.toISOString(), name: `${first} ${last}`, company,
    email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, "")}.com`, phone: `(${pick(["213", "310", "323", "818"])}) 555-0${String(100 + i).slice(-3)}`,
    status, source: "quote_builder", value_monthly: priced.monthly_total, value_one_time: priced.one_time_total,
  });
  quotes.push({
    id: uuid(), lead_id: id, created_at: created.toISOString(), updated_at: updated.toISOString(),
    status: status === "won" ? "accepted" : status === "lost" ? "declined" : status === "proposal" ? "sent" : status === "contacted" ? "reviewing" : "submitted",
    workstations: ws, servers: sv, ...priced, items: priced.items as Quote["items"],
    message: rand() < 0.5 ? pick(["We just had a phishing scare and want to lock things down.", "Our insurance renewal is asking about MFA and EDR.", "Need HIPAA help before our audit in the spring.", "Can you start next month?"]) : null,
  });
  audit.push({ id: audit.length + 1, at: created.toISOString(), actor: null, actor_role: "quote_intake", action: "insert", table_name: "leads", row_id: id, old_data: null, new_data: { status: "new" } });
  if (status !== "new") {
    audit.push({ id: audit.length + 1, at: updated.toISOString(), actor: "admin", actor_role: "authenticated", action: "update", table_name: "leads", row_id: id, old_data: { status: "new" }, new_data: { status } });
    notes.push({ id: uuid(), lead_id: id, created_at: updated.toISOString(), body: pick(["Called, left voicemail.", "Good fit. Sending proposal Friday.", "Wants pricing for 5 more seats.", "Decision maker is the office manager."]) });
  }
}

const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 120));
let signedOut = () => {};
const listeners = new Set<(e: ChangeEvent) => void>();
let state: AuthState = { step: "signed-out" };

const db: Db = {
  demo: true,
  authState: () => wait(state),
  signIn: async (email) => (state = { step: "enroll", email: email || "you@cyberx.la" }),
  enrollTotp: () => wait({
    factorId: "demo",
    secret: "JBSWY3DPEHPK3PXP",
    qr: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z" fill="none" stroke="#000" stroke-width="1.6"/><path d="M10 3h1v4h-1zM10 10h3v1h-3zM14 13h2v2h-2zM17 16h2v3h-2zM11 15h1v4h-1z" fill="#000"/></svg>'),
  }),
  verifyTotp: async (_f, code) => {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code from your authenticator app.");
    return (state = { step: "ready", email: "email" in state ? state.email : "you@cyberx.la" });
  },
  signOut: async () => { state = { step: "signed-out" }; signedOut(); },
  onSignedOut: (cb) => { signedOut = cb; },

  leads: () => wait([...leads].sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
  quotes: () => wait([...quotes].sort((a, b) => b.created_at.localeCompare(a.created_at))),
  lead: (id) => wait(leads.find((l) => l.id === id) ?? null),
  quotesFor: (id) => wait(quotes.filter((q) => q.lead_id === id)),
  notesFor: (id) => wait(notes.filter((n) => n.lead_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))),
  activityFor: (id) => wait(audit.filter((a) => a.row_id === id).sort((a, b) => b.at.localeCompare(a.at))),
  async setLeadStatus(id, status) {
    const l = leads.find((l) => l.id === id)!;
    audit.push({ id: audit.length + 1, at: new Date().toISOString(), actor: "admin", actor_role: "authenticated", action: "update", table_name: "leads", row_id: id, old_data: { status: l.status }, new_data: { status } });
    l.status = status; l.updated_at = new Date().toISOString();
    listeners.forEach((cb) => cb({ table: "leads", type: "UPDATE", row: l }));
  },
  async setQuoteStatus(id, status: QuoteStatus) {
    const q = quotes.find((q) => q.id === id)!;
    q.status = status;
  },
  async addNote(leadId, body) {
    notes.push({ id: uuid(), lead_id: leadId, created_at: new Date().toISOString(), body });
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export default db;
