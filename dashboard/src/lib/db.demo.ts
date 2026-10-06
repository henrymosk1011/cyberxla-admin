// Sample data for `npm run demo`. Never included in a production build
// (vite.config.ts only aliases $db to this file in demo mode).
import catalogSeed from "../../../tests/fixtures/catalog.json";
import { priceQuote } from "./catalog.ts";
import { catalog as liveCatalog } from "./store.svelte.ts";
import type { AuditEntry, AuthState, ChangeEvent, Client, ClientService, Db, Lead, LeadStatus, Note, Quote, QuoteStatus, ServiceCategory, ServiceRow } from "./types.ts";

const categories: ServiceCategory[] = catalogSeed.map((c, i) => ({ id: c.id, name: c.name, blurb: c.blurb, sort: i * 10 }));
const services: ServiceRow[] = catalogSeed.flatMap((c) => c.services.map((s, j) => ({
  id: s.id, category_id: c.id, name: s.name, description: s.description, price: s.price, unit: s.unit as ServiceRow["unit"],
  price_from: s.from, in_packages: s.in_packages, active: true, locked: ["patching", "edr", "mdr"].includes(s.id), sort: j * 10,
})));
const CATALOG = Object.fromEntries(services.map((s) => [s.id, s]));

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
  const priced = priceQuote(services, ids, ws, sv);
  const status: LeadStatus = ageDays < 6 ? pick(["new", "new", "contacted"] as const)
    : ageDays < 30 ? pick(["new", "contacted", "contacted", "proposal", "proposal", "won"] as const)
    : pick(["contacted", "proposal", "won", "won", "won", "lost", "lost"] as const);
  const first = pick(FIRST), last = pick(LAST), company = BIZ[i % BIZ.length]!;
  const id = uuid();
  const updated = new Date(Math.min(now, created.getTime() + rand() * 20 * 86400000));
  leads.push({
    id, created_at: created.toISOString(), updated_at: updated.toISOString(), name: `${first} ${last}`, company,
    email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, "")}.com`, phone: `(${pick(["213", "310", "323", "818"])}) 555-0${String(100 + i).slice(-3)}`,
    status, source: "quote_builder", value_monthly: priced.monthly_total, value_one_time: priced.one_time_total, archived_at: null,
  });
  quotes.push({
    id: uuid(), lead_id: id, created_at: created.toISOString(), updated_at: updated.toISOString(),
    status: status === "won" ? "accepted" : status === "lost" ? "declined" : status === "proposal" ? "sent" : status === "contacted" ? "reviewing" : "submitted",
    workstations: ws, servers: sv, ...priced, items: priced.items as Quote["items"],
    archived_at: null,
    message: rand() < 0.5 ? pick(["We just had a phishing scare and want to lock things down.", "Our insurance renewal is asking about MFA and EDR.", "Need HIPAA help before our audit in the spring.", "Can you start next month?"]) : null,
  });
  audit.push({ id: audit.length + 1, at: created.toISOString(), actor: null, actor_role: "quote_intake", action: "insert", table_name: "leads", row_id: id, old_data: null, new_data: { status: "new" } });
  if (status !== "new") {
    audit.push({ id: audit.length + 1, at: updated.toISOString(), actor: "admin", actor_role: "authenticated", action: "update", table_name: "leads", row_id: id, old_data: { status: "new" }, new_data: { status } });
    notes.push({ id: uuid(), lead_id: id, created_at: updated.toISOString(), body: pick(["Called, left voicemail.", "Good fit. Sending proposal Friday.", "Wants pricing for 5 more seats.", "Decision maker is the office manager."]) });
  }
}

// A few existing clients: some converted from won leads, one added by hand.
const clients: Client[] = [];
const clientServices: ClientService[] = [];
const total = (unit: number, qty: number) => Math.round(unit * qty * 100) / 100;
function clientFromLead(l: Lead): string {
  const q = quotes.filter((x) => x.lead_id === l.id && !x.archived_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const id = uuid();
  clients.push({
    id, created_at: l.updated_at, updated_at: l.updated_at, company: l.company, contact_name: l.name, email: l.email, phone: l.phone,
    address: null, status: "active", started_on: l.updated_at.slice(0, 10), workstations: q?.workstations ?? 0, servers: q?.servers ?? 0, notes: null, lead_id: l.id,
  });
  const devices = (q?.workstations ?? 0) + (q?.servers ?? 0);
  q?.items.forEach((it, i) => {
    const perDev = (it.unit === "dev" || it.unit === "devonce") && devices > 0 && total(it.unit_price, devices) === it.cost;
    clientServices.push({ id: uuid(), client_id: id, service_id: it.id, name: it.name, billing: it.kind === "monthly" ? "monthly" : "once",
      unit_amount: perDev ? it.unit_price : it.cost, quantity: perDev ? devices : 1, amount: it.cost, notes: null, sort: i * 10 });
  });
  return id;
}
leads.filter((l) => l.status === "won").slice(0, 7).forEach(clientFromLead);
{
  const id = uuid();
  clients.push({ id, created_at: new Date(now - 400 * 86400000).toISOString(), updated_at: new Date(now - 20 * 86400000).toISOString(), company: "Starlight Hospice", contact_name: "Dana Ortiz", email: "dana@starlighthospice.org", phone: "3235550142", address: "1200 Sunset Blvd, Los Angeles, CA", status: "active", started_on: "2025-08-01", workstations: 42, servers: 3, notes: "Renews every August. Prefers calls over email.", lead_id: null });
  ([["mdr", "24/7 MDR", 650, 1], ["patching", "Patching", 10, 48], ["hipaa", "HIPAA Security Support", 400, 1], ["cloudbackup", "Microsoft 365 and Google Backup", 4, 42]] as const).forEach(([sid, nm, unit, qty], i) =>
    clientServices.push({ id: uuid(), client_id: id, service_id: sid, name: nm, billing: "monthly", unit_amount: unit, quantity: qty, amount: total(unit, qty), notes: i === 0 ? "Discounted 10% (3-year term)" : null, sort: i * 10 }));
}
if (clients[1]) clients[1].status = "paused";
if (clients[2]) clients[2].status = "former";

const hiddenIds = new Set<number>();
function log(table: AuditEntry["table_name"], action: AuditEntry["action"], rowId: string, oldData: Record<string, unknown> | null, newData: Record<string, unknown> | null) {
  audit.push({ id: audit.length + 1, at: new Date().toISOString(), actor: "admin", actor_role: "authenticated", action, table_name: table, row_id: rowId, old_data: oldData, new_data: newData });
}
function refreshValue(leadId: string) {
  const l = leads.find((x) => x.id === leadId);
  if (!l) return;
  const q = quotes.filter((x) => x.lead_id === leadId && !x.archived_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  l.value_monthly = q?.monthly_total ?? 0;
  l.value_one_time = q?.one_time_total ?? 0;
}
const changed = (table: "leads" | "quotes", row: Record<string, unknown>) => listeners.forEach((cb) => cb({ table, type: "UPDATE", row }));

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
  activityFor: (id) => wait(audit
    .filter((a) => a.row_id === id || a.new_data?.lead_id === id || a.old_data?.lead_id === id)
    .map((a) => ({ ...a, hidden: hiddenIds.has(a.id) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  async setLeadStatus(id, status) {
    const l = leads.find((l) => l.id === id)!;
    audit.push({ id: audit.length + 1, at: new Date().toISOString(), actor: "admin", actor_role: "authenticated", action: "update", table_name: "leads", row_id: id, old_data: { status: l.status }, new_data: { status } });
    l.status = status; l.updated_at = new Date().toISOString();
    listeners.forEach((cb) => cb({ table: "leads", type: "UPDATE", row: l }));
  },
  async setQuoteStatus(id, status: QuoteStatus) {
    const q = quotes.find((q) => q.id === id)!;
    log("quotes", "update", q.id, { status: q.status, lead_id: q.lead_id }, { status, lead_id: q.lead_id });
    q.status = status;
  },
  async deleteNote(id) {
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const n = notes[i]!;
    notes.splice(i, 1);
    log("lead_notes", "delete", id, { lead_id: n.lead_id, body: n.body }, null);
  },
  async archiveLead(id, archived) {
    const l = leads.find((x) => x.id === id)!;
    const at = archived ? new Date().toISOString() : null;
    log("leads", "update", id, { status: l.status, archived_at: l.archived_at }, { status: l.status, archived_at: at });
    l.archived_at = at;
    changed("leads", l);
  },
  async deleteLead(id) {
    const i = leads.findIndex((x) => x.id === id);
    if (i >= 0) leads.splice(i, 1);
    for (let j = quotes.length - 1; j >= 0; j--) if (quotes[j]!.lead_id === id) quotes.splice(j, 1);
    changed("leads", { id });
  },
  async archiveQuote(id, archived) {
    const q = quotes.find((x) => x.id === id)!;
    const at = archived ? new Date().toISOString() : null;
    log("quotes", "update", id, { status: q.status, archived_at: q.archived_at, lead_id: q.lead_id }, { status: q.status, archived_at: at, lead_id: q.lead_id });
    q.archived_at = at;
    refreshValue(q.lead_id);
    changed("quotes", q);
  },
  async updateQuoteServices(id, serviceIds, workstations, servers) {
    const q = quotes.find((x) => x.id === id)!;
    const priced = priceQuote(liveCatalog.services, serviceIds, workstations, servers);
    log("quotes", "update", id,
      { lead_id: q.lead_id, status: q.status, items: q.items, workstations: q.workstations, servers: q.servers, monthly_total: q.monthly_total },
      { lead_id: q.lead_id, status: q.status, items: priced.items, workstations, servers, monthly_total: priced.monthly_total });
    Object.assign(q, { workstations, servers, ...priced, items: priced.items as Quote["items"] });
    refreshValue(q.lead_id);
    changed("quotes", q);
  },
  async deleteQuote(id) {
    const i = quotes.findIndex((x) => x.id === id);
    if (i < 0) return;
    const q = quotes[i]!;
    quotes.splice(i, 1);
    log("quotes", "delete", id, { monthly_total: q.monthly_total, lead_id: q.lead_id }, null);
    refreshValue(q.lead_id);
    changed("quotes", { lead_id: q.lead_id });
  },
  async hideActivity(auditId, hidden) {
    if (hidden) hiddenIds.add(auditId); else hiddenIds.delete(auditId);
  },
  async addNote(leadId, body) {
    notes.push({ id: uuid(), lead_id: leadId, created_at: new Date().toISOString(), body });
  },
  categories: () => wait([...categories].sort((a, b) => a.sort - b.sort)),
  services: () => wait([...services].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))),
  async saveCategory(c, isNew) {
    if (isNew) {
      if (categories.some((x) => x.id === c.id)) throw new Error("That name is already taken. Try a slightly different one.");
      categories.push({ ...c });
    } else Object.assign(categories.find((x) => x.id === c.id)!, c);
  },
  async deleteCategory(id) {
    if (services.some((s) => s.category_id === id)) throw new Error("This category still has services. Move or delete them first.");
    categories.splice(categories.findIndex((x) => x.id === id), 1);
  },
  async saveService(s, isNew) {
    const cur = services.find((x) => x.id === s.id);
    if (isNew) {
      if (cur) throw new Error("That name is already taken. Try a slightly different one.");
      services.push({ ...s, locked: false });
      return;
    }
    if (cur!.locked && !s.active) throw new Error(`${cur!.name} is used by the website packages and can't be hidden`);
    Object.assign(cur!, { ...s, locked: cur!.locked });
  },
  async deleteService(id) {
    const s = services.find((x) => x.id === id)!;
    if (s.locked) throw new Error(`${s.name} is used by the website packages and can't be deleted`);
    services.splice(services.indexOf(s), 1);
  },
  async reorder(table, ids) {
    const list: { id: string; sort: number }[] = table === "services" ? services : categories;
    ids.forEach((id, i) => { const r = list.find((x) => x.id === id); if (r) r.sort = i * 10; });
  },

  clients: () => wait([...clients].sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
  client: (id) => wait(clients.find((c) => c.id === id) ?? null),
  allClientServices: () => wait(clientServices),
  clientServices: (id) => wait(clientServices.filter((s) => s.client_id === id).sort((a, b) => a.sort - b.sort)),
  async createClient(c) {
    const id = uuid(), at = new Date().toISOString();
    clients.push({ ...c, id, created_at: at, updated_at: at });
    log("clients", "insert", id, null, { ...c });
    return id;
  },
  async updateClient(id, patch) {
    const c = clients.find((x) => x.id === id)!;
    log("clients", "update", id, { ...c }, { ...c, ...patch });
    Object.assign(c, patch, { updated_at: new Date().toISOString() });
  },
  async deleteClient(id) {
    clients.splice(clients.findIndex((x) => x.id === id), 1);
    for (let i = clientServices.length - 1; i >= 0; i--) if (clientServices[i]!.client_id === id) clientServices.splice(i, 1);
  },
  async addClientService(s) {
    const id = uuid();
    s = { ...s, amount: total(s.unit_amount, s.quantity) };
    clientServices.push({ ...s, id });
    log("client_services", "insert", id, null, { ...s });
  },
  async updateClientService(id, patch) {
    const s = clientServices.find((x) => x.id === id)!;
    patch = { ...patch };
    patch.amount = total(patch.unit_amount ?? s.unit_amount, patch.quantity ?? s.quantity);
    log("client_services", "update", id, { ...s }, { ...s, ...patch });
    Object.assign(s, patch);
  },
  async deleteClientService(id) {
    const i = clientServices.findIndex((x) => x.id === id);
    const s = clientServices[i]!;
    clientServices.splice(i, 1);
    log("client_services", "delete", id, { ...s }, null);
  },
  clientActivity: (id) => wait(audit
    .filter((a) => a.row_id === id || a.new_data?.client_id === id || a.old_data?.client_id === id)
    .map((a) => ({ ...a, hidden: hiddenIds.has(a.id) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  async convertLead(leadId) {
    const existing = clients.find((c) => c.lead_id === leadId);
    if (existing) return existing.id;
    const l = leads.find((x) => x.id === leadId)!;
    const id = clientFromLead(l);
    log("clients", "insert", id, null, { company: l.company });
    if (l.status !== "won") await db.setLeadStatus(leadId, "won");
    return id;
  },

  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export default db;
