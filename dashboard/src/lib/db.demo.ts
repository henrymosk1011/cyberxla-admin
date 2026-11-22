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
import type { Audit, AuditAuthorization, AuditDelivery, AuditEntry, AuditFinding, AuditGrade, AuditRow, AuditSettings, AuthState, ChangeEvent, Client, ClientService, Credential, Db, Lead, LeadStatus, Note, PackageRow, Payment, Project, Proposal, ProposalAcceptance, ProposalEvent, ProposalStatus, ProposalTemplate, ProposalVersion, ProjectService, ProjectStatus, Prospect, ProspectNote, ProspectStatus, Quote, QuoteSettings, QuoteStatus, Report, ReportContent, ReportPage, ReportSettings, ServiceCategory, ServiceRow, UnifiStatus, VaultConfig } from "./types.ts";
import templateSeed from "../../../tests/fixtures/workspace-template.json";
import { normalizeDoc, resolveDoc, totals as quoteTotals, varsFor, type ProposalDoc } from "../../../supabase/functions/_shared/proposal.ts";

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
    email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, "")}.example`, phone: `(${pick(["213", "310", "323", "818"])}) 555-0${String(100 + i).slice(-3)}`,
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
const NO_REPORTS = { action1_group: null, report_recipients: [] as string[], report_cc: [] as string[], reports_enabled: false, report_exclude: [] as string[], unifi_console: null };
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
  clients.push({ id, created_at: new Date(now - 400 * 86400000).toISOString(), updated_at: new Date(now - 20 * 86400000).toISOString(), company: "Starlight Hospice", contact_name: "Dana Ortiz", email: "dana@starlighthospice.example", phone: "3235550142", address: "1200 Sunset Blvd, Los Angeles, CA", status: "active", started_on: "2025-08-01", workstations: 42, servers: 3, notes: "Renews every August. Prefers calls over email.", lead_id: null, ...NO_REPORTS });
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
const reportSettings: ReportSettings = { mode: "preview", auto_send_default: true, generate_time: "12:00:00", send_time: "08:00:00", sunday_review_email: true, template: {}, updated_at: new Date(now - 9 * 86400000).toISOString() };
const reports: Report[] = [];
const reportPages = new Map<string, ReportPage[]>();
/** UniFi status by client (made up): Harbor Light's gateway, updated ten days ago, with an access point waiting. */
const unifi = new Map<string, UnifiStatus>();
const reportListeners = new Set<() => void>();
const reportsChanged = () => reportListeners.forEach((cb) => cb());
{
  const harbor = uuid();
  clients.push({ id: harbor, created_at: new Date(now - 300 * 86400000).toISOString(), updated_at: new Date(now - 30 * 86400000).toISOString(), company: "Harbor Light Dental", contact_name: "Jordan Reyes", email: "jordan@harborlight.example", phone: "8185550190", address: null, status: "active", started_on: "2026-01-12", workstations: 8, servers: 0, notes: null, lead_id: null,
    action1_group: "DEMO", report_recipients: ["office@harborlight.example"], report_cc: ["jordan@harborlight.example"], reports_enabled: true, report_exclude: [], unifi_console: "Harbor Light Gateway" });
  const others = clients.filter((c) => c.lead_id && c.status === "active").slice(0, 2);
  others.forEach((c, i) => Object.assign(c, { action1_group: `DEMO${i + 2}`, report_recipients: [`it@client${i + 2}.example`], report_cc: [], reports_enabled: true }));
  const day = 86400000;
  const iso = (ago: number) => new Date(now - ago).toISOString();
  unifi.set(harbor, {
    client_id: harbor, console: "Harbor Light Gateway", checked_at: iso(3 * 3600000),
    data: {
      v: 1, found: true, error: null, console: "Harbor Light Gateway",
      router: { name: "Harbor Light Gateway", model: "UCG Ultra", isConsole: true, status: "online", online: true, version: "4.4.1", needsUpdate: false, updateAvailable: null, startupTime: iso(10 * day), lastUpdate: { from: "4.3.6", to: "4.4.1", at: iso(10 * day) }, trackedSince: iso(60 * day) },
      devices: [
        { name: "Harbor Light Gateway", model: "UCG Ultra", isConsole: true, status: "online", online: true, version: "4.4.1", needsUpdate: false, updateAvailable: null, startupTime: iso(10 * day), lastUpdate: { from: "4.3.6", to: "4.4.1", at: iso(10 * day) }, trackedSince: iso(60 * day) },
        { name: "UniFi Network", model: "Network app", isConsole: false, isApp: true, status: "online", online: true, version: "10.6.109", needsUpdate: false, updateAvailable: null, startupTime: null, lastUpdate: { from: "10.6.106", to: "10.6.109", at: iso(10 * day + 900000) }, trackedSince: null },
        { name: "Front Office AP", model: "U6 Lite", isConsole: false, status: "online", online: true, version: "6.6.77", needsUpdate: true, updateAvailable: "6.7.10", startupTime: iso(42 * day), lastUpdate: null, trackedSince: iso(60 * day) },
      ],
    },
  });

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
      sent_at: o.status === "sent" ? new Date(o.sendAt + 240000).toISOString() : null, error: o.error ?? null, cleared_at: null,
    });
    if (o.pages && o.status !== "sent") reportPages.set(id, o.pages.map((src, i) => ({ page: i + 1, version: 1, src })));
  };
  const h = clients.find((c) => c.id === harbor)!;
  // The scheduled weekly report caught a UniFi update (made up), so it has a Network section.
  const withNetwork: ReportContent = { ...structuredClone(weeklyContent), network: { title: "Router", items: [
    { title: "Updated the router software", text: "Your router now runs version 4.4.1, installed Nov 4." },
    { title: "Updated the UniFi Network software", text: "Your UniFi Network now runs version 10.6.109, installed Nov 4." },
    { title: "No update this week: the Wi-Fi access point software", text: "Your Wi-Fi access point runs version 6.6.77." },
  ] } };
  add({ client: h, period: "weekly", content: withNetwork, email: reportSeed.weekly.email, sendAt: nextMon, status: "scheduled", pages: [weeklyPage1, weeklyPage2] });
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

// ---------------------------------------------------------------------------
// Prospecting demo data (sample businesses use the reserved .example domain)
// ---------------------------------------------------------------------------
const prospectingListeners = new Set<() => void>();
const prospectingChanged = () => prospectingListeners.forEach((cb) => cb());
const rmWhere = <T,>(arr: T[], pred: (x: T) => boolean) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) arr.splice(i, 1); };
const today = () => new Date().toISOString().slice(0, 10);

const auditSettings: AuditSettings = {
  mode: "preview", passive_enabled: true, active_enabled: false,
  sender_email: "audits@cyberx.la", sender_name: "cyberxLA Security", reply_to: "henry@cyberx.la",
  default_subject: "Security snapshot for {business}",
  default_body: "Hi there,\n\nWe ran a quick, non intrusive check of {business}'s public web presence and put the results in the attached one page report. It only uses information anyone can see from the outside; nothing was accessed.\n\nHappy to walk you through it if that would help.\n\nHenry\ncyberxLA",
  updated_at: new Date(now - 20 * 86400000).toISOString(),
};

const prospects: Prospect[] = [];
const prospectNotes: ProspectNote[] = [];
const audits: Audit[] = [];
const authorizations: AuditAuthorization[] = [];

// A small library of realistic passive findings.
const F: Record<string, AuditFinding> = {
  noDmarc: { id: "dmarc", category: "email", severity: "high", title: "No DMARC record", detail: "The domain publishes no DMARC policy, so anyone can send email that appears to come from this business. This is a common route for invoice and payroll fraud.", recommendation: "Publish a DMARC record, starting at p=none and moving to p=reject once legitimate mail passes.", service: "dmarc" },
  noSpf: { id: "spf", category: "email", severity: "medium", title: "No SPF record", detail: "There is no SPF record naming which servers may send mail for the domain, which weakens spoofing protection and hurts deliverability.", recommendation: "Add an SPF record listing your real mail providers.", service: "dmarc" },
  noHsts: { id: "hsts", category: "headers", severity: "medium", title: "HSTS not enabled", detail: "Browsers are not told to stay on HTTPS, which leaves a window for downgrade and interception on untrusted networks.", recommendation: "Send a Strict-Transport-Security header.", service: "surface" },
  noCsp: { id: "csp", category: "headers", severity: "medium", title: "No Content Security Policy", detail: "Nothing restricts which scripts the site may run, so an injected script would have free rein over visitor sessions.", recommendation: "Add a Content-Security-Policy header.", service: "surface" },
  noXfo: { id: "xfo", category: "headers", severity: "low", title: "No clickjacking protection", detail: "The site can be framed by other pages, which allows clickjacking of forms and buttons.", recommendation: "Add X-Frame-Options or a frame-ancestors policy.", service: "surface" },
  oldJquery: { id: "jquery", category: "software", severity: "high", title: "Outdated jQuery 1.12.4", detail: "The site loads jQuery 1.12.4, which has published cross-site scripting vulnerabilities and is years out of support.", recommendation: "Update jQuery to a current, supported release.", service: "patching" },
  serverBanner: { id: "banner", category: "exposure", severity: "low", title: "Software versions disclosed", detail: "Response headers reveal the exact web server and PHP versions, which hands an attacker a head start on matching known exploits.", recommendation: "Suppress Server and X-Powered-By version banners.", service: "surface" },
  cookieFlags: { id: "cookies", category: "cookies", severity: "medium", title: "Session cookie missing Secure and HttpOnly", detail: "A session cookie is set without the Secure and HttpOnly flags, so it can leak over plain HTTP or be read by injected scripts.", recommendation: "Set Secure, HttpOnly and SameSite on session cookies.", service: "surface" },
  wpExposed: { id: "wp-login", category: "exposure", severity: "medium", title: "WordPress login page open to the internet", detail: "The wp-login page is reachable with no rate limiting or extra factor, a frequent target for password guessing.", recommendation: "Add multi factor sign in and rate limiting, or restrict the admin area by network.", service: "mfa" },
  tlsOk: { id: "tls-ok", category: "tls", severity: "info", title: "Valid, current TLS certificate", detail: "The certificate is valid, matches the hostname, and is not expiring soon.", passed: true },
  dnssecOff: { id: "dnssec", category: "dns", severity: "low", title: "DNSSEC not enabled", detail: "DNS answers are not signed, which leaves room for DNS spoofing for visitors on a compromised network.", recommendation: "Enable DNSSEC at your DNS provider.", service: "surface" },
  httpsOk: { id: "https-ok", category: "tls", severity: "info", title: "HTTP redirects to HTTPS", detail: "Plain HTTP requests are redirected to HTTPS.", passed: true },
};

const SCAN_SETS: { grade: AuditGrade; score: number; summary: string; findings: AuditFinding[] }[] = [
  { grade: "C", score: 68, summary: "HTTPS and the certificate are healthy, but email spoofing protection and several security headers are missing.", findings: [F.noDmarc!, F.noHsts!, F.noCsp!, F.serverBanner!, F.tlsOk!, F.httpsOk!] },
  { grade: "D", score: 52, summary: "An outdated front-end library and weak email and cookie settings leave real openings worth closing.", findings: [F.oldJquery!, F.noDmarc!, F.cookieFlags!, F.noCsp!, F.noXfo!, F.tlsOk!] },
  { grade: "B", score: 83, summary: "A solid baseline. A couple of header and DNS hardening steps would take it further.", findings: [F.noHsts!, F.dnssecOff!, F.tlsOk!, F.httpsOk!] },
  { grade: "F", score: 39, summary: "Several high risk gaps: no spoofing protection, an exposed admin login, and outdated software.", findings: [F.noDmarc!, F.noSpf!, F.wpExposed!, F.oldJquery!, F.cookieFlags!, F.noCsp!] },
];

/** Fill an audit with a believable result (the real scan runs in GitHub Actions). */
function simulateScan(a: Audit) {
  const set = SCAN_SETS[Math.floor(rand() * SCAN_SETS.length)]!;
  const biz = prospects.find((p) => p.id === a.prospect_id);
  const t = new Date().toISOString();
  Object.assign(a, {
    scan_status: "done", grade: set.grade, score: set.score, summary: set.summary, findings: set.findings,
    meta: { ip: "203.0.113." + (10 + Math.floor(rand() * 200)), tls: { issuer: "Let's Encrypt", days_left: 61 } },
    scanner_version: "0.1.0", started_at: t, finished_at: t, content_version: 1, rendered_version: 1, rendered_at: t, updated_at: t,
    subject: a.subject ?? `Security snapshot for ${biz?.business_name ?? "your business"}`,
    email_body: a.email_body ?? auditSettings.default_body,
  });
  if (biz && (biz.status === "new" || biz.status === "auditing")) { biz.status = "audited"; biz.updated_at = t; }
}

{
  type Seed = { name: string; domain: string; city: string; industry: string; status: ProspectStatus; age: number; email?: string | null; contact?: string };
  const seeds: Seed[] = [
    { name: "Rosewood Dental Studio", domain: "rosewooddental.example", city: "Pasadena", industry: "Dentist", status: "audited", age: 6, email: "office@rosewooddental.example", contact: "Dana Brooks" },
    { name: "Vista Auto Repair", domain: "vistaauto.example", city: "Glendale", industry: "Auto repair", status: "new", age: 2, email: null },
    { name: "Lotus Thai Kitchen", domain: "lotusthai.example", city: "Burbank", industry: "Restaurant", status: "audited", age: 9, email: "hello@lotusthai.example", contact: "Noi Prasert" },
    { name: "Keystone Property Group", domain: "keystonepg.example", city: "Los Angeles", industry: "Property management", status: "contacted", age: 15, email: "info@keystonepg.example", contact: "Marcus Field" },
    { name: "Harborview Family Law", domain: "harborviewlaw.example", city: "Long Beach", industry: "Law firm", status: "new", age: 1, email: "intake@harborviewlaw.example" },
    { name: "Summit Physical Therapy", domain: "summitpt.example", city: "Santa Monica", industry: "Physical therapy", status: "audited", age: 11, email: "front@summitpt.example", contact: "Elena Ruiz" },
    { name: "Atlas Hardware Supply", domain: "atlashardware.example", city: "Inglewood", industry: "Retail", status: "responded", age: 22, email: "sales@atlashardware.example", contact: "Ray Okafor" },
  ];
  const by: Record<string, Prospect> = {};
  seeds.forEach((s, i) => {
    const created = new Date(now - s.age * 86400000);
    const p: Prospect = {
      id: uuid(), created_at: created.toISOString(), updated_at: created.toISOString(), business_name: s.name,
      website: `https://${s.domain}`, domain: s.domain, contact_name: s.contact ?? null, email: s.email ?? null,
      phone: `(${pick(["213", "310", "323", "818", "562"])}) 555-0${String(100 + i).slice(-3)}`,
      city: s.city, region: "CA", industry: s.industry, status: s.status, source: pick(["yelp", "google_places", "manual"] as const),
      source_ref: null, lead_id: null, notes: null, archived_at: null,
    };
    prospects.push(p);
    by[s.name] = p;
  });

  const mkAudit = (p: Prospect, set: { grade: AuditGrade; score: number; summary: string; findings: AuditFinding[] }, o: { age: number; delivery?: AuditDelivery } = { age: 1 }): Audit => {
    const created = new Date(now - o.age * 86400000);
    const a: Audit = {
      id: uuid(), created_at: created.toISOString(), updated_at: created.toISOString(), prospect_id: p.id, kind: "passive",
      is_test: false, scan_status: "done", target_url: p.website, target_domain: p.domain, grade: set.grade, score: set.score,
      summary: set.summary, scanner_version: "0.1.0", started_at: created.toISOString(), finished_at: created.toISOString(),
      scan_error: null, attempts: 1, authorization_id: null, content_version: 1, rendered_version: 1, rendered_at: created.toISOString(),
      render_error: null, delivery: o.delivery ?? "none", recipients: p.email ? [p.email] : [],
      subject: `Security snapshot for ${p.business_name}`, sent_at: o.delivery === "sent" ? created.toISOString() : null, send_error: null,
      findings: set.findings, meta: { ip: "203.0.113." + (20 + Math.floor(rand() * 200)), tls: { issuer: "Let's Encrypt", days_left: 61 } },
      email_body: auditSettings.default_body,
    };
    audits.push(a);
    return a;
  };

  mkAudit(by["Rosewood Dental Studio"]!, SCAN_SETS[0]!, { age: 5 });
  mkAudit(by["Lotus Thai Kitchen"]!, SCAN_SETS[1]!, { age: 8 });
  mkAudit(by["Keystone Property Group"]!, SCAN_SETS[2]!, { age: 13, delivery: "sent" });
  mkAudit(by["Atlas Hardware Supply"]!, SCAN_SETS[2]!, { age: 20, delivery: "sent" });
  mkAudit(by["Summit Physical Therapy"]!, SCAN_SETS[3]!, { age: 10 });

  // Vista Auto Repair: a scan that failed because the site could not be reached.
  {
    const p = by["Vista Auto Repair"]!, created = new Date(now - 2 * 86400000).toISOString();
    audits.push({ id: uuid(), created_at: created, updated_at: created, prospect_id: p.id, kind: "passive", is_test: false,
      scan_status: "failed", target_url: p.website, target_domain: p.domain, grade: null, score: null, summary: null, scanner_version: "0.1.0",
      started_at: created, finished_at: created, scan_error: "The site did not respond on HTTPS within the timeout.", attempts: 1,
      authorization_id: null, content_version: 1, rendered_version: 0, rendered_at: null, render_error: null, delivery: "none",
      recipients: [], subject: null, sent_at: null, send_error: null, findings: [], meta: {}, email_body: null });
  }

  // Summit Physical Therapy engaged us: a recorded authorization unlocks an active audit, now queued.
  {
    const p = by["Summit Physical Therapy"]!, at = new Date(now - 3 * 86400000);
    const auth: AuditAuthorization = { id: uuid(), created_at: at.toISOString(), prospect_id: p.id, domain: p.domain!,
      scope: "External active testing of the public web presence", method: "signed_doc", authorized_by_name: "Elena Ruiz",
      authorized_by_title: "Owner", authorized_by_email: "front@summitpt.example", evidence: "Signed engagement letter 2026-11",
      signed_on: at.toISOString().slice(0, 10), expires_on: new Date(now + 60 * 86400000).toISOString().slice(0, 10), revoked_at: null };
    authorizations.push(auth);
    const qAt = new Date(now - 1 * 86400000).toISOString();
    audits.push({ id: uuid(), created_at: qAt, updated_at: qAt, prospect_id: p.id, kind: "active", is_test: false, scan_status: "queued",
      target_url: p.website, target_domain: p.domain, grade: null, score: null, summary: null, scanner_version: null, started_at: null,
      finished_at: null, scan_error: null, attempts: 0, authorization_id: auth.id, content_version: 1, rendered_version: 0, rendered_at: null,
      render_error: null, delivery: "none", recipients: p.email ? [p.email] : [], subject: null, sent_at: null, send_error: null, findings: [], meta: {}, email_body: null });
  }

  prospectNotes.push({ id: uuid(), prospect_id: by["Keystone Property Group"]!.id, created_at: new Date(now - 12 * 86400000).toISOString(), body: "Sent the snapshot. Office manager replied, wants to talk after the holidays." });
}

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
    if (patch.status === "scheduled" || patch.status === "held") r.cleared_at = null;
    logReport("update", before, r);
    reportsChanged();
  },
  async clearReports(ids, cleared) {
    let n = 0;
    for (const r of reports.filter((x) => ids.includes(x.id))) {
      if (cleared && !(r.is_test ? r.status !== "sending" : ["sent", "failed", "cancelled"].includes(r.status))) throw new Error("Only sent, failed, cancelled or test reports can be archived");
      const before = structuredClone(r);
      r.cleared_at = cleared ? new Date().toISOString() : null;
      logReport("update", before, r);
      n++;
    }
    reportsChanged();
    return n;
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
    if (r.status === "sending") throw new Error("This report is sending and can't be deleted");
    if (r.status === "sent" && !r.is_test && !r.cleared_at) throw new Error("Sent reports are kept for the record. Clear it first, then delete it from Cleared.");
    reports.splice(reports.indexOf(r), 1);
    logReport("delete", r, null);
    reportsChanged();
  },
  async deleteReports(ids) {
    // All or nothing, like the database (one statement).
    const list = reports.filter((x) => ids.includes(x.id));
    for (const r of list) {
      if (r.status === "sending") throw new Error("This report is sending and can't be deleted");
      if (r.status === "sent" && !r.is_test && !r.cleared_at) throw new Error("Sent reports are kept for the record. Clear it first, then delete it from Cleared.");
    }
    for (const r of list) {
      reports.splice(reports.indexOf(r), 1);
      logReport("delete", r, null);
    }
    reportsChanged();
    return list.length;
  },
  async reportAction(id, action) {
    const r = reports.find((x) => x.id === id)!;
    if (action === "unifi") {
      // The real check is a GitHub run (about a minute); the demo just stamps the time.
      const s = unifi.get(r.client_id);
      if (s) setTimeout(() => { s.checked_at = new Date().toISOString(); }, 2500);
      return { started: "unifi" };
    }
    // The real copy is a GitHub run that emails Henry; nothing about the report changes.
    if (action === "copy") return { started: "copy" };
    if (r.status === "sending") throw new Error("This report is already sending.");
    if (r.status === "sent") throw new Error("This report was already sent.");
    if (action === "render" || action === "rebuild") {
      if (action === "render" && r.rendered_version >= r.content_version) return { started: null };
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
  unifiStatus: (clientId: string) => wait(structuredClone(unifi.get(clientId) ?? null)),
  reportSettings: () => wait(reportSettings),
  async saveReportSettings(patch) {
    log("report_settings", "update", "settings", { ...reportSettings }, { ...reportSettings, ...patch });
    Object.assign(reportSettings, patch, { updated_at: new Date().toISOString() });
  },
  subscribeReports(cb) {
    reportListeners.add(cb);
    return () => reportListeners.delete(cb);
  },

  async createLead(l) {
    if (leads.some((x) => x.email.toLowerCase() === l.email.trim().toLowerCase())) throw new Error("A lead with that email already exists. Pick it from the list instead.");
    const id = uuid(), at = new Date().toISOString();
    leads.push({ id, created_at: at, updated_at: at, ...l, email: l.email.trim().toLowerCase(), status: "new", source: "manual", value_monthly: 0, value_one_time: 0, archived_at: null });
    log("leads", "insert", id, null, { status: "new" });
    return id;
  },
  proposals: () => wait([...proposals].sort((a, b) => b.number - a.number)),
  proposal: (id) => wait(proposals.find((p) => p.id === id) ?? null),
  async createProposal(input) {
    const id = uuid(), at = new Date().toISOString();
    proposals.push({ ...input, content: normalizeDoc(input.content), id, number: nextNumber++, created_at: at, updated_at: at, status: "draft", token: uuid().replace(/-/g, ""), version: 0, revising: false, link_only: false,
      scheduled_at: null, send_subject: null, send_note: null, sent_at: null, last_sent_at: null, first_viewed_at: null, last_viewed_at: null, view_count: 0,
      changes_requested_at: null, accepted_at: null, accepted_version: null, accepted_once: null, accepted_monthly: null, archived_at: null });
    event(id, "created", {});
    return id;
  },
  async updateProposal(id, patch) {
    const p = proposals.find((x) => x.id === id)!;
    const docChange = ("content" in patch && JSON.stringify(patch.content) !== JSON.stringify(p.content)) || ("title" in patch && patch.title !== p.title);
    if (docChange && !(p.status === "draft" || p.status === "scheduled" || p.revising)) {
      throw new Error(p.status === "accepted" ? `Q${p.number} was accepted, so it's locked. Use Revise to make a new version for the client to accept.` : `Q${p.number} was sent. Use Revise to change it.`);
    }
    Object.assign(p, patch, { updated_at: new Date().toISOString() });
    if (docChange) {
      const last = proposalEvents.filter((e) => e.proposal_id === id).sort((a, b) => b.id - a.id)[0];
      if (last?.kind === "edited") last.at = new Date().toISOString(); else event(id, "edited", {});
    }
    proposalsChanged();
  },
  async deleteProposal(id) {
    const p = proposals.find((x) => x.id === id)!;
    if (p.version > 0 && !p.archived_at) throw new Error(`Q${p.number} was sent, so it's kept for the record. Archive it first, then delete it.`);
    proposals.splice(proposals.indexOf(p), 1);
    proposalsChanged();
  },
  proposalEvents: (id) => wait(proposalEvents.filter((e) => e.proposal_id === id).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  recentProposalEvents: (n) => wait(proposalEvents.filter((e) => e.kind !== "edited").sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, n)),
  proposalVersions: (id) => wait(proposalVersions.filter((v) => v.proposal_id === id).sort((a, b) => b.version - a.version)),
  proposalAcceptances: (id) => wait(proposalAcceptances.filter((a) => a.proposal_id === id)),
  async proposalRpc(fn, args) {
    const p = proposals.find((x) => x.id === args.p_id)!;
    const set = (patch: Partial<Proposal>) => { Object.assign(p, patch, { updated_at: new Date().toISOString() }); proposalsChanged(); };
    switch (fn) {
      case "proposal_schedule": set({ scheduled_at: String(args.p_at), send_subject: String(args.p_subject), send_note: String(args.p_note ?? ""), status: p.status === "draft" ? "scheduled" : p.status }); event(p.id, "scheduled", { at: args.p_at }); return null;
      case "proposal_publish": {
        if (!(p.status === "draft" || p.status === "scheduled" || p.revising)) throw new Error(`Q${p.number} was already sent. Use Revise to send a new version.`);
        if (!p.recipient_email) throw new Error("Add the recipient's email first.");
        freeze(p);
        p.link_only = true;
        const sent = proposalEvents.filter((e) => e.proposal_id === p.id && e.kind === "sent").at(-1);
        if (sent) sent.detail = { ...sent.detail, emailed: false };
        return null;
      }
      case "proposal_unschedule": set({ scheduled_at: null, status: p.status === "scheduled" ? "draft" : p.status }); event(p.id, "unscheduled", {}); return null;
      case "proposal_revise": set({ revising: true }); event(p.id, "revision_started", { version: p.version + 1 }); return null;
      case "proposal_discard_revision": {
        const v = proposalVersions.find((x) => x.proposal_id === p.id && x.version === p.version)!;
        set({ revising: false, content: structuredClone(sources.get(v.id)!.content), title: sources.get(v.id)!.title }); event(p.id, "revision_discarded", {}); return null;
      }
      case "proposal_revoke": set({ status: "revoked" }); event(p.id, "revoked", {}); return null;
      case "proposal_new_link": set({ token: uuid().replace(/-/g, ""), status: p.status === "revoked" ? (p.first_viewed_at ? "viewed" : "sent") : p.status }); event(p.id, "link_regenerated", {}); return null;
      case "proposal_set_declined": set({ status: args.p_declined ? "declined" : p.first_viewed_at ? "viewed" : "sent" }); event(p.id, args.p_declined ? "declined" : "reopened", {}); return null;
      case "proposal_duplicate": {
        const id = await db.createProposal({ lead_id: p.lead_id, client_id: p.client_id, title: p.title, recipient_name: p.recipient_name, recipient_email: p.recipient_email, cc: p.cc,
          prepared_on: new Date().toISOString().slice(0, 10), valid_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), content: structuredClone(p.content), internal: structuredClone(p.internal), internal_notes: p.internal_notes, reminders: p.reminders });
        event(id, "duplicated", { from: `Q${p.number}` });
        return id;
      }
      case "proposal_convert": {
        const existing = projects.find((x) => x.proposal_id === p.id);
        if (existing) return existing.id;
        if (args.p_convert_lead && p.lead_id) { const cid = await db.convertLead(p.lead_id); for (const q of proposals.filter((x) => x.lead_id === p.lead_id)) Object.assign(q, { lead_id: null, client_id: cid }); }
        const acc = proposalAcceptances.find((a) => a.proposal_id === p.id);
        const lines = acc ? acc.lines : (args.p_lines as ProposalAcceptance["lines"]);
        const id = await db.createProject({ lead_id: p.lead_id, client_id: p.client_id, name: p.title, status: acc ? "in_progress" : "proposed", due_on: null, notes: `From quote Q${p.number}.` });
        projects.find((x) => x.id === id)!.proposal_id = p.id;
        lines.forEach((l, i) => projectServices.push({ id: uuid(), project_id: id, service_id: null, name: l.name, billing: l.billing, unit_amount: l.net / 100, quantity: 1, amount: l.net / 100, notes: null, sort: i * 10 }));
        event(p.id, "converted", { project_id: id });
        return id;
      }
    }
    return null;
  },
  async quoteAction(body) {
    // Demo only: localStorage "demo.noEmail" shows the admin as it is before email is set up.
    const noEmail = (() => { try { return !!localStorage.getItem("demo.noEmail"); } catch { return false; } })();
    if (body.action === "status") return { ok: true, email: !noEmail, stripe: quoteSettings.stripe_mode, stripe_key: false, stripe_webhook: false, webhook_url: "https://YOUR-PROJECT.supabase.co/functions/v1/stripe-webhook" };
    if (noEmail && body.action !== "test_payment") throw new Error("Email isn't set up yet, so nothing was sent. Use Publish and send the link yourself, or add the RESEND_API_KEY secret in Supabase (README, Setup for sending).");
    if (body.action === "test_payment") throw new Error("Stripe isn't connected yet. Add the two Stripe secrets first (see README, Connect Stripe).");
    const qid = "id" in body ? body.id : "";
    const p = proposals.find((x) => x.id === qid)!;
    if (body.action === "test") { event(p.id, "test_sent", { to: [quoteSettings.notify_email] }); return { ok: true, to: [quoteSettings.notify_email], cc: [] }; }
    if (body.action === "resend") { p.link_only = false; event(p.id, "resent", { to: [p.recipient_email] }); return { ok: true, to: [p.recipient_email], cc: p.cc }; }
    if (!(p.status === "draft" || p.status === "scheduled" || p.revising)) throw new Error(`Q${p.number} was already sent. Use Revise to send a new version, or Resend to email it again.`);
    if (!p.recipient_email) throw new Error("Add the recipient's email first.");
    freeze(p);
    return { ok: true, to: [p.recipient_email], cc: p.cc, version: p.version };
  },
  templates: () => wait(templates),
  async saveTemplate(t, id) {
    if (templates.some((x) => x.name.toLowerCase() === t.name.toLowerCase() && x.id !== id)) throw new Error("A template with that name already exists. Pick another name.");
    const at = new Date().toISOString();
    if (id) { Object.assign(templates.find((x) => x.id === id)!, t, { updated_at: at }); return id; }
    const nid = uuid();
    templates.push({ ...structuredClone(t), id: nid, created_at: at, updated_at: at });
    return nid;
  },
  async deleteTemplate(id) { templates.splice(templates.findIndex((t) => t.id === id), 1); },
  quoteSettings: () => wait(quoteSettings),
  async saveQuoteSettings(patch) { Object.assign(quoteSettings, patch, { updated_at: new Date().toISOString() }); },
  payments: () => wait(payments),
  subscribeProposals(cb) { proposalListeners.add(cb); return () => proposalListeners.delete(cb); },

  // -- Prospecting -----------------------------------------------------------
  prospects: () => wait([...prospects].sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
  prospect: (id) => wait(prospects.find((p) => p.id === id) ?? null),
  createProspect: async (p) => {
    const id = uuid(), t = new Date().toISOString();
    const row: Prospect = { id, created_at: t, updated_at: t, status: "new", lead_id: null, archived_at: null, ...p } as Prospect;
    prospects.unshift(row);
    log("prospects", "insert", id, null, { status: "new", business_name: row.business_name });
    prospectingChanged();
    return id;
  },
  updateProspect: async (id, patch) => {
    const p = prospects.find((x) => x.id === id);
    if (p) { Object.assign(p, patch); p.updated_at = new Date().toISOString(); prospectingChanged(); }
  },
  deleteProspect: async (id) => {
    rmWhere(audits, (a) => a.prospect_id === id);
    rmWhere(prospectNotes, (n) => n.prospect_id === id);
    rmWhere(authorizations, (a) => a.prospect_id === id);
    rmWhere(prospects, (p) => p.id === id);
    prospectingChanged();
  },
  archiveProspect: async (id, archived) => {
    const p = prospects.find((x) => x.id === id);
    if (p) { p.archived_at = archived ? new Date().toISOString() : null; p.updated_at = new Date().toISOString(); prospectingChanged(); }
  },
  importProspects: async (rows) => {
    const t = new Date().toISOString();
    for (const r of rows) prospects.unshift({ id: uuid(), created_at: t, updated_at: t, status: "new", lead_id: null, archived_at: null, ...r } as Prospect);
    prospectingChanged();
    return rows.length;
  },
  prospectNotes: (id) => wait(prospectNotes.filter((n) => n.prospect_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))),
  addProspectNote: async (pid, body) => { prospectNotes.push({ id: uuid(), prospect_id: pid, created_at: new Date().toISOString(), body }); },
  deleteProspectNote: async (id) => { rmWhere(prospectNotes, (n) => n.id === id); },
  prospectActivity: (id) => wait(audit.filter((a) => a.row_id === id || a.new_data?.prospect_id === id || a.old_data?.prospect_id === id).map((a) => ({ ...a, hidden: hiddenIds.has(a.id) })).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  convertProspect: async (id) => {
    const p = prospects.find((x) => x.id === id);
    if (!p) throw new Error("That prospect was deleted. Reload and try again.");
    if (!p.email) throw new Error("Add a contact email to the prospect before converting it to a lead.");
    const leadId = uuid(), t = new Date().toISOString();
    leads.unshift({ id: leadId, created_at: t, updated_at: t, name: p.contact_name || p.business_name, company: p.business_name, email: p.email, phone: p.phone, status: "new", source: "manual", value_monthly: 0, value_one_time: 0, archived_at: null });
    p.lead_id = leadId; p.status = "converted"; p.updated_at = t;
    prospectingChanged();
    return leadId;
  },

  audits: () => wait([...audits].sort((a, b) => b.created_at.localeCompare(a.created_at)) as AuditRow[]),
  auditsFor: (pid) => wait(audits.filter((a) => a.prospect_id === pid).sort((a, b) => b.created_at.localeCompare(a.created_at)) as AuditRow[]),
  audit: (id) => wait(audits.find((a) => a.id === id) ?? null),
  auditPages: () => wait([]),
  auditPdf: () => wait(null),
  auditActivity: (id) => wait(audit.filter((a) => a.table_name === "audits" && a.row_id === id).map((a) => ({ ...a, hidden: hiddenIds.has(a.id) })).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
  updateAudit: async (id, patch) => {
    const a = audits.find((x) => x.id === id);
    if (a) { Object.assign(a, patch); a.updated_at = new Date().toISOString(); prospectingChanged(); }
  },
  deleteAudit: async (id) => { rmWhere(audits, (a) => a.id === id); prospectingChanged(); },
  startAudit: async (prospectId, kind, isTest) => {
    if (kind === "active" && !authorizations.some((a) => a.prospect_id === prospectId && !a.revoked_at && a.signed_on <= today() && a.expires_on >= today()))
      throw new Error("An active audit needs a current signed authorization for this domain.");
    const p = prospects.find((x) => x.id === prospectId);
    const id = uuid(), t = new Date().toISOString();
    audits.unshift({ id, created_at: t, updated_at: t, prospect_id: prospectId, kind, is_test: isTest, scan_status: "queued", target_url: p?.website ?? null, target_domain: p?.domain ?? null, grade: null, score: null, summary: null, scanner_version: null, started_at: null, finished_at: null, scan_error: null, attempts: 0, authorization_id: kind === "active" ? (authorizations.find((a) => a.prospect_id === prospectId && !a.revoked_at)?.id ?? null) : null, content_version: 1, rendered_version: 0, rendered_at: null, render_error: null, delivery: "none", recipients: p?.email ? [p.email] : [], subject: null, sent_at: null, send_error: null, findings: [], meta: {}, email_body: null });
    log("audits", "insert", id, null, { kind, prospect_id: prospectId });
    prospectingChanged();
    return id;
  },
  auditAction: async (id, action) => {
    const a = audits.find((x) => x.id === id);
    if (!a) throw new Error("That audit was deleted. Reload and try again.");
    if (action === "scan" || action === "rescan") { simulateScan(a); prospectingChanged(); return { started: "scan" }; }
    if (action === "send_now") {
      a.delivery = "sent"; a.sent_at = new Date().toISOString(); a.updated_at = a.sent_at;
      const p = prospects.find((x) => x.id === a.prospect_id);
      if (p && (p.status === "audited" || p.status === "auditing")) { p.status = "contacted"; p.updated_at = a.sent_at; }
      prospectingChanged();
      return { started: "send" };
    }
    if (action === "copy") return { started: "copy" };
    if (action === "rebuild") return { started: "render" };
    if (action === "cancel") { if (a.scan_status === "queued" || a.scan_status === "running") { a.scan_status = "cancelled"; prospectingChanged(); } return { started: null }; }
    return { started: null };
  },
  scanProspects: async (ids, rescan) => {
    const targets = prospects.filter((p) => !p.archived_at && p.website
      && (ids === null || ids.includes(p.id))
      && !audits.some((a) => a.prospect_id === p.id && (a.scan_status === "queued" || a.scan_status === "running"))
      && (rescan || !audits.some((a) => a.prospect_id === p.id)));
    const t = new Date().toISOString();
    for (const p of targets) {
      const id = uuid();
      audits.unshift({ id, created_at: t, updated_at: t, prospect_id: p.id, kind: "passive", is_test: false, scan_status: "queued", target_url: p.website ?? null, target_domain: p.domain ?? null, grade: null, score: null, summary: null, scanner_version: null, started_at: null, finished_at: null, scan_error: null, attempts: 0, authorization_id: null, content_version: 1, rendered_version: 0, rendered_at: null, render_error: null, delivery: "none", recipients: p.email ? [p.email] : [], subject: null, sent_at: null, send_error: null, findings: [], meta: {}, email_body: null });
      log("audits", "insert", id, null, { kind: "passive", prospect_id: p.id });
    }
    prospectingChanged();
    return targets.length;
  },
  scanQueue: async () => {
    for (const a of audits.filter((x) => x.scan_status === "queued")) simulateScan(a);
    prospectingChanged();
  },

  authorizations: (pid) => wait(authorizations.filter((a) => a.prospect_id === pid).sort((a, b) => b.created_at.localeCompare(a.created_at))),
  addAuthorization: async (a) => { authorizations.unshift({ id: uuid(), created_at: new Date().toISOString(), revoked_at: null, ...a }); prospectingChanged(); },
  setAuthorizationRevoked: async (id, revoked) => { const a = authorizations.find((x) => x.id === id); if (a) { a.revoked_at = revoked ? new Date().toISOString() : null; prospectingChanged(); } },
  deleteAuthorization: async (id) => { rmWhere(authorizations, (a) => a.id === id); prospectingChanged(); },

  auditSettings: () => wait(auditSettings),
  saveAuditSettings: async (patch) => { Object.assign(auditSettings, patch); auditSettings.updated_at = new Date().toISOString(); },
  discoverProspects: async (params) => {
    const names = ["Bayside", "Copper Kettle", "Elm Street", "Granite Peak", "Harbor Point", "Ironwood", "Jasmine", "Kingfisher"];
    const n = Math.min(params.limit || 5, 8), t = new Date().toISOString();
    let added = 0;
    for (let i = 0; i < n; i++) {
      const nm = `${names[(i + Math.floor(rand() * names.length)) % names.length]} ${params.term || "Services"}`;
      const dom = nm.toLowerCase().replace(/[^a-z]/g, "") + ".example";
      if (prospects.some((p) => p.domain === dom)) continue;
      prospects.unshift({ id: uuid(), created_at: t, updated_at: t, business_name: nm, website: `https://${dom}`, domain: dom, contact_name: null, email: null, phone: null, city: params.location || "Los Angeles", region: "CA", industry: params.term || null, status: "new", source: params.source, source_ref: uuid(), lead_id: null, notes: null, archived_at: null });
      added++;
    }
    prospectingChanged();
    return { found: n, added };
  },
  subscribeProspecting: (cb) => { prospectingListeners.add(cb); return () => prospectingListeners.delete(cb); },
};

// ---------------------------------------------------------------------------
// Outgoing quotes in the demo: a template, a draft, a sent one and an
// accepted one, all for made up clients on the reserved .example domain.
// ---------------------------------------------------------------------------
function freeze(p: Proposal) {
  const owner = p.client_id ? clients.find((c) => c.id === p.client_id) : undefined;
  const lead = p.lead_id ? leads.find((l) => l.id === p.lead_id) : undefined;
  const vars = varsFor({ number: p.number, company: owner?.company ?? lead?.company ?? null, contact_name: p.recipient_name || owner?.contact_name || lead?.name || null, valid_until: p.valid_until });
  const vid = uuid();
  p.version += 1;
  proposalVersions.push({ id: vid, proposal_id: p.id, version: p.version, sent_at: new Date().toISOString(),
    header: { number: `Q${p.number}`, title: p.title, prepared_for: vars.company, prepared_on: p.prepared_on, valid_until: p.valid_until }, content: resolveDoc(normalizeDoc(p.content), vars) });
  sources.set(vid, { title: p.title, content: structuredClone(p.content) });
  Object.assign(p, { status: "sent" as ProposalStatus, revising: false, link_only: false, scheduled_at: null, sent_at: p.sent_at ?? new Date().toISOString(), last_sent_at: new Date().toISOString(), accepted_at: null, accepted_once: null, accepted_monthly: null });
  if (lead && (lead.status === "new" || lead.status === "contacted")) lead.status = "proposal";
  event(p.id, "sent", { version: p.version, to: p.recipient_email });
  proposalsChanged();
}
/** Demo only: move a just frozen quote's send back in time. */
function backdate(p: Proposal, days: number) {
  const at = new Date(now - days * 86400000).toISOString();
  Object.assign(p, { sent_at: at, last_sent_at: at });
  for (const v of proposalVersions) if (v.proposal_id === p.id) v.sent_at = at;
  for (const e of proposalEvents) if (e.proposal_id === p.id && e.kind === "sent") e.at = at;
}
function event(proposalId: string, kind: string, detail: Record<string, unknown>, at = new Date().toISOString()) {
  proposalEvents.push({ id: ++eventId, proposal_id: proposalId, at, kind, detail, notify: null, notified_at: null });
}
const proposalsChanged = () => proposalListeners.forEach((cb) => cb());
const proposalListeners = new Set<() => void>();
const proposals: Proposal[] = [];
const proposalEvents: ProposalEvent[] = [];
const proposalVersions: ProposalVersion[] = [];
const proposalAcceptances: ProposalAcceptance[] = [];
const sources = new Map<string, { title: string; content: ProposalDoc }>();
const payments: Payment[] = [];
let nextNumber = 1001, eventId = 0;
const quoteSettings: QuoteSettings = { notify_email: "henry@cyberx.la", reply_to: "henry@cyberx.la", from_name: "Henry at cyberxLA", default_valid_days: 30, remind_unviewed_days: 3, remind_expiry_days: 2, stripe_mode: "off", stripe_checked_at: null, cron_seen_at: null, updated_at: new Date().toISOString() };
const templates: ProposalTemplate[] = [{ id: uuid(), created_at: new Date(now - 5 * 86400000).toISOString(), updated_at: new Date(now - 5 * 86400000).toISOString(), name: "Google Workspace migration", title: "Google Workspace migration", content: normalizeDoc(templateSeed), internal: {} }];
{
  const day = (n: number) => new Date(now + n * 86400000).toISOString().slice(0, 10);
  const target = clients.find((c) => c.company === "Starlight Hospice")!;
  const open = leads.filter((l) => ["new", "contacted", "proposal"].includes(l.status));
  const make = (o: { owner: { lead_id?: string; client_id?: string }; name: string; email: string; title: string; ago: number; costs?: Record<string, number> }) => {
    const id = uuid(), at = new Date(now - o.ago * 86400000).toISOString();
    const p: Proposal = { id, number: nextNumber++, created_at: at, updated_at: at, lead_id: o.owner.lead_id ?? null, client_id: o.owner.client_id ?? null, title: o.title, status: "draft",
      recipient_name: o.name, recipient_email: o.email, cc: [], prepared_on: day(-o.ago), valid_until: day(30 - o.ago), content: normalizeDoc(templateSeed), token: uuid().replace(/-/g, ""),
      version: 0, revising: false, link_only: false, scheduled_at: null, send_subject: null, send_note: null, reminders: false, sent_at: null, last_sent_at: null, first_viewed_at: null, last_viewed_at: null,
      view_count: 0, changes_requested_at: null, accepted_at: null, accepted_version: null, accepted_once: null, accepted_monthly: null, archived_at: null,
      internal: { costs: o.costs ?? {} }, internal_notes: null };
    proposals.push(p);
    event(id, "created", {}, at);
    return p;
  };
  const a = make({ owner: { client_id: target.id }, name: "Dana Ortiz", email: "dana@starlighthospice.example", title: "Google Workspace migration", ago: 9, costs: { "tier:pro": 1200 } });
  freeze(a);
  backdate(a, 9);
  Object.assign(a, { status: "accepted", first_viewed_at: new Date(now - 8 * 86400000).toISOString(), last_viewed_at: new Date(now - 7 * 86400000).toISOString(), view_count: 3 });
  const t = quoteTotals(proposalVersions.at(-1)!.content, "pro", ["usb"]);
  const accId = uuid();
  proposalAcceptances.push({ id: accId, proposal_id: a.id, version: 1, accepted_at: new Date(now - 7 * 86400000).toISOString(), tier: "pro", addons: ["usb"], lines: t.lines,
    once_total: t.once_total / 100, monthly_total: t.monthly_total / 100, due_now: 0, signer_name: "Dana Ortiz", signer_title: "Administrator", signer_email: "dana@starlighthospice.example", signature: "Dana Ortiz", doc: proposalVersions.at(-1)!.content });
  Object.assign(a, { accepted_at: new Date(now - 7 * 86400000).toISOString(), accepted_version: 1, accepted_once: t.once_total / 100, accepted_monthly: 0 });
  event(a.id, "viewed", { count: 1 }, a.first_viewed_at!);
  event(a.id, "accepted", { tier: "pro", addons: ["usb"], by: "Dana Ortiz", once_total: t.once_total / 100 }, a.accepted_at!);
  // Converted into a project, the way the Convert button does it.
  {
    const pid = uuid(), at = a.accepted_at!;
    projects.push({ id: pid, created_at: at, updated_at: at, lead_id: null, client_id: target.id, name: a.title, status: "in_progress", due_on: null, notes: `From quote Q${a.number}.`, proposal_id: a.id });
    t.lines.forEach((l, i) => projectServices.push({ id: uuid(), project_id: pid, service_id: null, name: l.name, billing: l.billing, unit_amount: l.net / 100, quantity: 1, amount: l.net / 100, notes: null, sort: i * 10 }));
    event(a.id, "converted", { project_id: pid }, at);
  }
  if (open[0]) {
    const b = make({ owner: { lead_id: open[0].id }, name: open[0].name, email: open[0].email, title: "Google Workspace migration", ago: 3 });
    freeze(b);
    backdate(b, 3);
    Object.assign(b, { status: "viewed", first_viewed_at: new Date(now - 2 * 86400000).toISOString(), last_viewed_at: new Date(now - 86400000).toISOString(), view_count: 2 });
    event(b.id, "viewed", { count: 1 }, b.first_viewed_at!);
  }
  if (open[1]) make({ owner: { lead_id: open[1].id }, name: open[1].name, email: open[1].email, title: "Office email move", ago: 1 });
}

export default db;
