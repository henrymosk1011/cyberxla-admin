// Sample data for `npm run demo`. Never included in a production build
// (vite.config.ts only aliases $db to this file in demo mode).
import catalogSeed from "../../../tests/fixtures/catalog.json";
import reportSeed from "../../../tests/fixtures/report-content.json";
import weeklyPage1 from "./demo/report-weekly-1.png";
import weeklyPage2 from "./demo/report-weekly-2.png";
import monthlyPage1 from "./demo/report-monthly-1.png";
import monthlyPage2 from "./demo/report-monthly-2.png";
import { priceQuote } from "./catalog.ts";
import { catalog as liveCatalog } from "./store.svelte.ts";
import type { AuditEntry, AuthState, ChangeEvent, Client, ClientService, Credential, Db, Lead, LeadStatus, Note, PackageRow, Project, ProjectService, ProjectStatus, Quote, QuoteStatus, Report, ReportContent, ReportPage, ReportSettings, ServiceCategory, ServiceRow, VaultConfig } from "./types.ts";

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
const NO_REPORTS = { action1_group: null, report_recipients: [] as string[], report_cc: [] as string[], reports_enabled: false, report_exclude: [] as string[] };
const clientServices: ClientService[] = [];
const packages: PackageRow[] = [
  { id: "essential", name: "Essential", rates: [10, 9.5, 9, 8.5], sort: 0 },
  { id: "secure", name: "Secure", rates: [18, 17, 16, 15], sort: 1 },
  { id: "shield", name: "Shield", rates: [32, 30, 28.5, 27], sort: 2 },
];
const total = (unit: number, qty: number) => Math.round(unit * qty * 100) / 100;
function clientFromLead(l: Lead): string {
  const q = quotes.filter((x) => x.lead_id === l.id && !x.archived_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const id = uuid();
  clients.push({
    id, created_at: l.updated_at, updated_at: l.updated_at, company: l.company, contact_name: l.name, email: l.email, phone: l.phone,
    address: null, status: "active", started_on: l.updated_at.slice(0, 10), workstations: q?.workstations ?? 0, servers: q?.servers ?? 0, notes: null, lead_id: l.id,
    ...NO_REPORTS,
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
  clients.push({ id, created_at: new Date(now - 400 * 86400000).toISOString(), updated_at: new Date(now - 20 * 86400000).toISOString(), company: "Starlight Hospice", contact_name: "Dana Ortiz", email: "dana@starlighthospice.org", phone: "3235550142", address: "1200 Sunset Blvd, Los Angeles, CA", status: "active", started_on: "2025-08-01", workstations: 42, servers: 3, notes: "Renews every August. Prefers calls over email.", lead_id: null, ...NO_REPORTS });
  ([["mdr", "24/7 MDR", 650, 1], ["patching", "Patching", 10, 48], ["hipaa", "HIPAA Security Support", 400, 1], ["cloudbackup", "Microsoft 365 and Google Backup", 4, 42]] as const).forEach(([sid, nm, unit, qty], i) =>
    clientServices.push({ id: uuid(), client_id: id, service_id: sid, name: nm, billing: "monthly", unit_amount: unit, quantity: qty, amount: total(unit, qty), notes: i === 0 ? "Discounted 10% (3-year term)" : null, sort: i * 10 }));
}
if (clients[1]) clients[1].status = "paused";
if (clients[2]) clients[2].status = "former";

// Projects on a few clients and open leads. The credential vault starts empty:
// set a passphrase in the demo and the encryption runs for real in the browser.
const projects: Project[] = [];
const projectServices: ProjectService[] = [];
let credentials: Credential[] = [];
let vaultConfig: VaultConfig | null = null;
type SeedLine = readonly [serviceId: string | null, name: string, billing: "monthly" | "once", unit: number, qty: number];
function seedProject(owner: { lead_id?: string; client_id?: string }, name: string, status: ProjectStatus, dueInDays: number | null, notes: string | null, lines: SeedLine[]) {
  const id = uuid(), at = new Date(now - (5 + Math.floor(rand() * 40)) * 86400000).toISOString();
  projects.push({ id, created_at: at, updated_at: at, lead_id: owner.lead_id ?? null, client_id: owner.client_id ?? null, name, status,
    due_on: dueInDays === null ? null : new Date(now + dueInDays * 86400000).toISOString().slice(0, 10), notes });
  lines.forEach(([sid, nm, billing, unit, qty], i) =>
    projectServices.push({ id: uuid(), project_id: id, service_id: sid, name: nm, billing, unit_amount: unit, quantity: qty, amount: total(unit, qty), notes: null, sort: i * 10 }));
}
const starlight = clients.find((c) => c.company === "Starlight Hospice")!;
seedProject({ client_id: starlight.id }, "Office Wi-Fi refresh", "proposed", 21, "Two floors, ~60 users. Guest network has to be fully separated from clinical.\nSite walk with Dana on the 14th.", [
  [null, "On-site network survey", "once", 1200, 1], ["hardening", "Device Hardening", "once", 35, 45], ["firewall", "Firewall and Wi-Fi Security", "monthly", 150, 1],
]);
seedProject({ client_id: starlight.id }, "Annual HIPAA risk analysis", "in_progress", 9, "Last year's report is in the shared drive.", [
  ["risk", "Security Risk Assessment", "once", 3500, 1], ["policies", "Security Policies", "once", 2000, 1],
]);
seedProject({ client_id: starlight.id }, "MFA rollout", "done", -30, null, [["mfa", "MFA Rollout", "once", 50, 42]]);
if (clients[0]) seedProject({ client_id: clients[0].id }, "Microsoft 365 migration", "potential", null, "Currently on GoDaddy email. Wants it done before tax season.", [
  [null, "Mailbox migration", "once", 85, 18], ["cloudbackup", "Microsoft 365 and Google Backup", "monthly", 4, 18],
]);
const openLeads = leads.filter((l) => ["new", "contacted", "proposal"].includes(l.status));
if (openLeads[0]) seedProject({ lead_id: openLeads[0].id }, "Email security cleanup", "potential", null, "Spoofed invoices went out from their domain last month.", [
  ["dmarc", "SPF, DKIM, and DMARC", "once", 750, 1], ["filtering", "Email Filtering", "monthly", 4, 12],
]);
if (openLeads[1]) seedProject({ lead_id: openLeads[1].id }, "Pentest before insurance renewal", "proposed", 35, null, [["pentest", "Penetration Testing", "once", 5000, 1]]);

// Patch reports. Content and page images are made up (from the reports repo's
// invented test snapshot); a demo client gets them, plus two converted clients
// with sample addresses on the reserved .example domain.
const reportSettings: ReportSettings = { mode: "preview", auto_send_default: true, generate_time: "12:00:00", send_time: "08:00:00", sunday_review_email: true, updated_at: new Date(now - 9 * 86400000).toISOString() };
const reports: Report[] = [];
const reportPages = new Map<string, ReportPage[]>();
const reportListeners = new Set<() => void>();
const reportsChanged = () => reportListeners.forEach((cb) => cb());
{
  const harbor = uuid();
  clients.push({ id: harbor, created_at: new Date(now - 300 * 86400000).toISOString(), updated_at: new Date(now - 30 * 86400000).toISOString(), company: "Harbor Light Dental", contact_name: "Jordan Reyes", email: "jordan@harborlight.example", phone: "8185550190", address: null, status: "active", started_on: "2026-01-12", workstations: 8, servers: 0, notes: null, lead_id: null,
    action1_group: "DEMO", report_recipients: ["office@harborlight.example"], report_cc: ["jordan@harborlight.example"], reports_enabled: true, report_exclude: [] });
  const others = clients.filter((c) => c.lead_id && c.status === "active").slice(0, 2);
  others.forEach((c, i) => Object.assign(c, { action1_group: `DEMO${i + 2}`, report_recipients: [`it@client${i + 2}.example`], report_cc: [], reports_enabled: true }));

  // Next Monday 8:00 AM (this browser's time) and the Monday before.
  const d = new Date(now);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  d.setHours(8, 0, 0, 0);
  const nextMon = d.getTime();
  const lastMon = nextMon - 7 * 86400000;
  const ymd = (t: number) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const isoWeek = (t: number) => {
    const x = new Date(Date.UTC(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()));
    x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
    const y = x.getUTCFullYear();
    return `${y}-W${String(Math.ceil(((x.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, "0")}`;
  };
  const weeklyContent = reportSeed.weekly.content as ReportContent;
  const monthlyContent = reportSeed.monthly.content as ReportContent;
  const renamed = (c: ReportContent, name: string): ReportContent => ({ ...structuredClone(c), title: name, doc_title: c.doc_title.replace("Harbor Light Dental", name) });
  const add = (o: { client: Client; period: "weekly" | "monthly"; content: ReportContent; email: { subject: string; body: string }; sendAt: number; status: Report["status"]; test?: boolean; warnings?: string[]; error?: string | null; pages?: string[] }) => {
    const id = uuid();
    const created = new Date(o.sendAt - 20 * 3600000).toISOString();
    const friday = ymd(o.sendAt - 3 * 86400000);
    const lastMonth = new Date(new Date(o.sendAt).getFullYear(), new Date(o.sendAt).getMonth() - 1, 1);
    const monthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
    const name = o.client.company ?? "Client";
    const subject = o.email.subject.replace("Harbor Light Dental", name);
    const body = o.email.body.replace("Harbor Light Dental", name);
    reports.push({
      id, created_at: created, updated_at: created, client_id: o.client.id, client_name: name, period: o.period,
      period_key: o.period === "weekly" ? isoWeek(o.sendAt - 86400000) : monthKey,
      period_start: o.period === "weekly" ? friday : `${monthKey}-01`, period_end: o.period === "weekly" ? friday : ymd(new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0).getTime()),
      is_test: !!o.test, status: o.status, send_at: new Date(o.sendAt).toISOString(), recipients: o.client.report_recipients, cc: o.client.report_cc,
      subject, email_body: body, content: o.content, original: { content: structuredClone(o.content), subject, email_body: body },
      failure_count: o.period === "weekly" ? 5 : 4, warnings: o.warnings ?? [], content_version: 1, rendered_version: 1, rendered_at: created, render_error: null,
      claimed_at: o.status === "sent" || o.status === "failed" ? new Date(o.sendAt + 120000).toISOString() : null, attempts: o.status === "sent" || o.status === "failed" ? 1 : 0,
      sent_at: o.status === "sent" ? new Date(o.sendAt + 240000).toISOString() : null, error: o.error ?? null,
    });
    if (o.pages && o.status !== "sent") reportPages.set(id, o.pages.map((src, i) => ({ page: i + 1, version: 1, src })));
  };
  const h = clients.find((c) => c.id === harbor)!;
  add({ client: h, period: "weekly", content: weeklyContent, email: reportSeed.weekly.email, sendAt: nextMon, status: "scheduled", pages: [weeklyPage1, weeklyPage2] });
  add({ client: h, period: "monthly", content: monthlyContent, email: reportSeed.monthly.email, sendAt: nextMon, status: "held", pages: [monthlyPage1, monthlyPage2] });
  add({ client: h, period: "weekly", content: weeklyContent, email: reportSeed.weekly.email, sendAt: nextMon, status: "held", test: true, pages: [weeklyPage1, weeklyPage2] });
  add({ client: h, period: "weekly", content: weeklyContent, email: reportSeed.weekly.email, sendAt: lastMon, status: "sent" });
  if (others[0]) {
    add({ client: others[0], period: "weekly", content: renamed(weeklyContent, others[0].company ?? "Client"), email: reportSeed.weekly.email, sendAt: nextMon, status: "held",
      warnings: [`No patch run this week. The report repeats the run from ${ymd(lastMon - 3 * 86400000)}.`] });
    add({ client: others[0], period: "weekly", content: renamed(weeklyContent, others[0].company ?? "Client"), email: reportSeed.weekly.email, sendAt: lastMon, status: "sent" });
  }
  if (others[1]) {
    add({ client: others[1], period: "weekly", content: renamed(weeklyContent, others[1].company ?? "Client"), email: reportSeed.weekly.email, sendAt: nextMon, status: "scheduled" });
    add({ client: others[1], period: "weekly", content: renamed(weeklyContent, others[1].company ?? "Client"), email: reportSeed.weekly.email, sendAt: lastMon, status: "failed",
      error: "Graph sendMail failed: HTTP 403 ErrorAccessDenied" });
  }
}
/** Like the database's audit trigger: no big columns, content only when it changed. */
function logReport(action: AuditEntry["action"], before: Report | null, after: Report | null) {
  const light = (r: Report | null, keepContent: boolean) => {
    if (!r) return null;
    const { original: _o, content, ...rest } = r;
    return keepContent ? { ...rest, content } : rest;
  };
  const contentChanged = !!before && !!after && JSON.stringify(before.content) !== JSON.stringify(after.content);
  log("reports", action, (after ?? before)!.id, light(before, contentChanged), light(after, contentChanged));
}
const ALLOWED: Record<string, string[]> = {
  scheduled: ["held", "cancelled"], held: ["scheduled", "cancelled"], failed: ["scheduled", "held", "cancelled"], cancelled: ["held", "scheduled"], sending: ["sent", "failed"], sent: [],
};

const hiddenIds = new Set<number>();
// Like the database's audit trigger: credentials are logged without their ciphertext.
const redact = ({ secret: _, ...rest }: Pick<Credential, "secret"> & Record<string, unknown>) => rest;
function dropProject(id: string) {
  const i = projects.findIndex((x) => x.id === id);
  if (i < 0) return;
  log("projects", "delete", id, { ...projects[i]! }, null);
  projects.splice(i, 1);
  for (let j = projectServices.length - 1; j >= 0; j--) if (projectServices[j]!.project_id === id) projectServices.splice(j, 1);
  credentials = credentials.filter((c) => c.project_id !== id);
}
function moveProjects(leadId: string, clientId: string) {
  for (const p of projects.filter((x) => x.lead_id === leadId)) {
    log("projects", "update", p.id, { ...p }, { ...p, lead_id: null, client_id: clientId });
    Object.assign(p, { lead_id: null, client_id: clientId });
  }
}
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
  allNotes: () => wait([...notes].sort((a, b) => a.created_at.localeCompare(b.created_at))),
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
    projects.filter((p) => p.lead_id === id).forEach((p) => dropProject(p.id));
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
  packages: () => wait(packages.map((p) => ({ ...p, rates: [...p.rates] }))),
  async savePackageRates(id, rates) {
    packages.find((p) => p.id === id)!.rates = [...rates];
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
    clients.push({ ...NO_REPORTS, ...c, id, created_at: at, updated_at: at });
    log("clients", "insert", id, null, { ...c });
    return id;
  },
  async updateClient(id, patch) {
    const c = clients.find((x) => x.id === id)!;
    log("clients", "update", id, { ...c }, { ...c, ...patch });
    Object.assign(c, patch, { updated_at: new Date().toISOString() });
  },
  async deleteClient(id) {
    if (reports.some((r) => r.client_id === id)) throw new Error("This client has patch reports, which are kept for the record. Set their status to Former instead.");
    clients.splice(clients.findIndex((x) => x.id === id), 1);
    for (let i = clientServices.length - 1; i >= 0; i--) if (clientServices[i]!.client_id === id) clientServices.splice(i, 1);
    projects.filter((p) => p.client_id === id).forEach((p) => dropProject(p.id));
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
    if (existing) {
      moveProjects(leadId, existing.id);
      return existing.id;
    }
    const l = leads.find((x) => x.id === leadId)!;
    const id = clientFromLead(l);
    log("clients", "insert", id, null, { company: l.company, lead_id: leadId });
    moveProjects(leadId, id);
    if (l.status !== "won") await db.setLeadStatus(leadId, "won");
    return id;
  },

  projects: () => wait([...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
  project: (id) => wait(projects.find((p) => p.id === id) ?? null),
  allProjectServices: () => wait(projectServices),
  projectServices: (id) => wait(projectServices.filter((s) => s.project_id === id).sort((a, b) => a.sort - b.sort)),
  async createProject(p) {
    const id = uuid(), at = new Date().toISOString();
    projects.push({ ...p, id, created_at: at, updated_at: at });
    log("projects", "insert", id, null, { ...p });
    return id;
  },
  async updateProject(id, patch) {
    const p = projects.find((x) => x.id === id)!;
    log("projects", "update", id, { ...p }, { ...p, ...patch });
    Object.assign(p, patch, { updated_at: new Date().toISOString() });
  },
  async deleteProject(id) {
    dropProject(id);
  },
  async addProjectService(s) {
    const id = uuid();
    s = { ...s, amount: total(s.unit_amount, s.quantity) };
    projectServices.push({ ...s, id });
    log("project_services", "insert", id, null, { ...s });
  },
  async updateProjectService(id, patch) {
    const s = projectServices.find((x) => x.id === id)!;
    patch = { ...patch };
    patch.amount = total(patch.unit_amount ?? s.unit_amount, patch.quantity ?? s.quantity);
    log("project_services", "update", id, { ...s }, { ...s, ...patch });
    Object.assign(s, patch);
  },
  async deleteProjectService(id) {
    const i = projectServices.findIndex((x) => x.id === id);
    const s = projectServices[i]!;
    projectServices.splice(i, 1);
    log("project_services", "delete", id, { ...s }, null);
  },
  projectActivity: (id) => wait(audit
    .filter((a) => a.row_id === id || a.new_data?.project_id === id || a.old_data?.project_id === id)
    .map((a) => ({ ...a, hidden: hiddenIds.has(a.id) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),

  vault: () => wait(vaultConfig),
  async createVault(v) {
    if (vaultConfig) throw new Error("A vault was just set up in another tab. Reload this page and unlock it with that passphrase.");
    vaultConfig = { ...v };
  },
  async updateVault(v) {
    vaultConfig = { ...v };
  },
  async resetVault() {
    credentials.forEach((c) => log("project_credentials", "delete", c.id, redact(c), null));
    credentials = [];
    vaultConfig = null;
  },
  credentials: (projectId) => wait(credentials.filter((c) => c.project_id === projectId).sort((a, b) => a.sort - b.sort)),
  credentialCount: () => wait(credentials.length),
  async saveCredential(c, isNew) {
    const at = new Date().toISOString();
    if (isNew) {
      credentials.push({ ...c, created_at: at, updated_at: at });
      log("project_credentials", "insert", c.id, null, redact(c));
      return;
    }
    const cur = credentials.find((x) => x.id === c.id)!;
    log("project_credentials", "update", c.id, redact(cur), redact(c));
    Object.assign(cur, { label: c.label, secret: c.secret, sort: c.sort, updated_at: at });
  },
  async deleteCredential(id) {
    const c = credentials.find((x) => x.id === id)!;
    credentials = credentials.filter((x) => x.id !== id);
    log("project_credentials", "delete", id, redact(c), null);
  },

  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  reports: () => wait(reports.map(({ content: _c, original: _o, email_body: _b, ...r }) => r).sort((a, b) => b.send_at.localeCompare(a.send_at))),
  report: (id) => wait(reports.find((r) => r.id === id) ?? null),
  reportFiles: (id) => {
    const r = reports.find((x) => x.id === id);
    if (!r || !r.rendered_version) return wait([]);
    const at = r.rendered_at ?? r.created_at;
    return wait([
      { kind: "client" as const, page: 0, version: r.rendered_version, size: 34239, created_at: at },
      { kind: "internal" as const, page: 0, version: r.rendered_version, size: 41615, created_at: at },
      ...(reportPages.get(id) ?? []).map((p) => ({ kind: "page" as const, page: p.page, version: r.rendered_version, size: 30000, created_at: at })),
    ]);
  },
  reportPages: (id) => wait(reportPages.get(id) ?? []),
  reportPdf: async () => {
    throw new Error("The demo has no PDFs to download. The real panel downloads the rendered PDF.");
  },
  reportActivity: (id) => wait(audit.filter((a) => a.table_name === "reports" && a.row_id === id).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  async updateReport(id, patch) {
    const r = reports.find((x) => x.id === id)!;
    const before = structuredClone(r);
    if ((r.status === "sending" || r.status === "sent") && Object.keys(patch).some((k) => k !== "status")) throw new Error(`This report is ${r.status} and can't be edited`);
    if (patch.status && patch.status !== r.status && !ALLOWED[r.status]!.includes(patch.status)) throw new Error(`A report can't go from ${r.status} to ${patch.status}`);
    if (patch.recipients && (patch.recipients.length < 1 || patch.recipients.length > 10)) throw new Error("Something isn't valid: check the recipients (1 to 10 real addresses), the subject, and the body.");
    Object.assign(r, patch, { updated_at: new Date().toISOString() });
    if (patch.content && JSON.stringify(patch.content) !== JSON.stringify(before.content)) r.content_version++;
    if (patch.status === "sent") r.sent_at = new Date().toISOString();
    if (patch.status === "failed" && before.status === "sending") r.error = "Marked as not sent from the dashboard.";
    if (patch.status === "scheduled") r.error = null;
    logReport("update", before, r);
    reportsChanged();
  },
  async moveReports(ids, from, to) {
    let n = 0;
    for (const r of reports.filter((x) => ids.includes(x.id) && x.status === from)) {
      await db.updateReport(r.id, { status: to });
      n++;
    }
    return n;
  },
  async deleteReport(id) {
    const r = reports.find((x) => x.id === id)!;
    if (r.status === "sending" || (r.status === "sent" && !r.is_test)) throw new Error("Sent reports are kept for the record and can't be deleted");
    reports.splice(reports.indexOf(r), 1);
    logReport("delete", r, null);
    reportsChanged();
  },
  async reportAction(id, action) {
    const r = reports.find((x) => x.id === id)!;
    if (r.status === "sending") throw new Error("This report is already sending.");
    if (r.status === "sent") throw new Error("This report was already sent.");
    if (action === "render") {
      if (r.rendered_version >= r.content_version) return { started: null };
      // The real panel takes about a minute (a GitHub run); the demo keeps the sample pages.
      setTimeout(() => { r.rendered_version = r.content_version; r.rendered_at = new Date().toISOString(); reportsChanged(); }, 2500);
      return { started: "render" };
    }
    await db.updateReport(id, { status: "scheduled", send_at: new Date().toISOString() });
    setTimeout(() => {
      const before = structuredClone(r);
      Object.assign(r, { status: "sending", claimed_at: new Date().toISOString(), attempts: r.attempts + 1 });
      logReport("update", before, r);
      reportsChanged();
      setTimeout(() => {
        const b2 = structuredClone(r);
        Object.assign(r, { status: "sent", sent_at: new Date().toISOString(), rendered_version: r.content_version });
        reportPages.delete(id);
        logReport("update", b2, r);
        reportsChanged();
      }, 2500);
    }, 1500);
    return { started: "send" };
  },
  reportSettings: () => wait(reportSettings),
  async saveReportSettings(patch) {
    log("report_settings", "update", "settings", { ...reportSettings }, { ...reportSettings, ...patch });
    Object.assign(reportSettings, patch, { updated_at: new Date().toISOString() });
  },
  subscribeReports(cb) {
    reportListeners.add(cb);
    return () => reportListeners.delete(cb);
  },
};

export default db;
