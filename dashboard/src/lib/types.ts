export const LEAD_STATUSES = ["new", "contacted", "proposal", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const OPEN_STATUSES: readonly LeadStatus[] = ["new", "contacted", "proposal"];

export const QUOTE_STATUSES = ["submitted", "reviewing", "sent", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export type Lead = {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  status: LeadStatus;
  source: "quote_builder" | "contact" | "manual";
  value_monthly: number;
  value_one_time: number;
  archived_at: string | null;
};

export type QuoteItem = {
  id: string;
  name: string;
  unit: "dev" | "mo" | "once" | "devonce";
  unit_price: number;
  from: boolean;
  kind: "monthly" | "once";
  cost: number;
};

export type Quote = {
  id: string;
  lead_id: string;
  created_at: string;
  updated_at: string;
  status: QuoteStatus;
  workstations: number;
  servers: number;
  items: QuoteItem[];
  monthly_total: number;
  one_time_total: number;
  monthly_minimum_applied: boolean;
  message: string | null;
  archived_at: string | null;
};

export type Note = { id: string; lead_id: string; created_at: string; body: string };

export type AuditEntry = {
  id: number;
  at: string;
  actor: string | null;
  actor_role: string;
  action: "insert" | "update" | "delete";
  table_name: "leads" | "quotes" | "lead_notes" | "clients" | "client_services" | "services" | "service_categories"
    | "projects" | "project_services" | "project_credentials" | "reports" | "report_settings"
    | "proposals" | "proposal_versions" | "proposal_events" | "proposal_acceptances" | "proposal_templates" | "payments" | "quote_settings"
    | "prospects" | "prospect_notes" | "audits" | "audit_authorizations" | "audit_settings";
  row_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  hidden?: boolean;
};

export type AuthState =
  | { step: "signed-out" }
  | { step: "enroll"; email: string }
  | { step: "mfa"; email: string; factorId: string }
  | { step: "denied"; email: string }
  | { step: "ready"; email: string };

export type Enrollment = { factorId: string; qr: string; secret: string };

export type ChangeEvent = { table: "leads" | "quotes"; type: "INSERT" | "UPDATE" | "DELETE"; row: { lead_id?: string; monthly_total?: number | string; [k: string]: unknown } };

/** Everything the UI needs from the back end. db.ts (Supabase) and db.demo.ts implement it. */
export interface Db {
  readonly demo: boolean;
  authState(): Promise<AuthState>;
  signIn(email: string, password: string): Promise<AuthState>;
  enrollTotp(): Promise<Enrollment>;
  verifyTotp(factorId: string, code: string): Promise<AuthState>;
  signOut(): Promise<void>;
  onSignedOut(cb: () => void): void;

  leads(): Promise<Lead[]>;
  quotes(): Promise<Quote[]>;
  lead(id: string): Promise<Lead | null>;
  quotesFor(leadId: string): Promise<Quote[]>;
  notesFor(leadId: string): Promise<Note[]>;
  /** Every note on every lead, oldest first (for exports). */
  allNotes(): Promise<Note[]>;
  activityFor(leadId: string): Promise<AuditEntry[]>;
  setLeadStatus(id: string, status: LeadStatus): Promise<void>;
  setQuoteStatus(id: string, status: QuoteStatus): Promise<void>;
  addNote(leadId: string, body: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
  archiveLead(id: string, archived: boolean): Promise<void>;
  deleteLead(id: string): Promise<void>;
  archiveQuote(id: string, archived: boolean): Promise<void>;
  /** Replace a quote's services and device counts; prices are recalculated from the catalog. */
  updateQuoteServices(id: string, serviceIds: string[], workstations: number, servers: number): Promise<void>;
  deleteQuote(id: string): Promise<void>;
  hideActivity(auditId: number, hidden: boolean): Promise<void>;

  categories(): Promise<ServiceCategory[]>;
  services(): Promise<ServiceRow[]>;
  saveCategory(c: ServiceCategory, isNew: boolean): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  saveService(s: ServiceRow, isNew: boolean): Promise<void>;
  deleteService(id: string): Promise<void>;
  /** Persist a new order: each id gets sort = index * 10. */
  reorder(table: "services" | "service_categories", ids: string[]): Promise<void>;
  packages(): Promise<PackageRow[]>;
  savePackageRates(id: PackageId, rates: number[]): Promise<void>;

  clients(): Promise<Client[]>;
  client(id: string): Promise<Client | null>;
  allClientServices(): Promise<ClientService[]>;
  clientServices(clientId: string): Promise<ClientService[]>;
  createClient(c: ClientInput): Promise<string>;
  updateClient(id: string, patch: Partial<ClientInput>): Promise<void>;
  deleteClient(id: string): Promise<void>;
  addClientService(s: Omit<ClientService, "id">): Promise<void>;
  updateClientService(id: string, patch: Partial<Omit<ClientService, "id" | "client_id">>): Promise<void>;
  deleteClientService(id: string): Promise<void>;
  clientActivity(clientId: string): Promise<AuditEntry[]>;
  /** Create (or find) the client for a lead from its newest active quote; returns the client id. */
  convertLead(leadId: string): Promise<string>;

  projects(): Promise<Project[]>;
  project(id: string): Promise<Project | null>;
  allProjectServices(): Promise<ProjectService[]>;
  projectServices(projectId: string): Promise<ProjectService[]>;
  createProject(p: ProjectInput): Promise<string>;
  updateProject(id: string, patch: Partial<ProjectInput>): Promise<void>;
  deleteProject(id: string): Promise<void>;
  addProjectService(s: Omit<ProjectService, "id">): Promise<void>;
  updateProjectService(id: string, patch: Partial<Omit<ProjectService, "id" | "project_id">>): Promise<void>;
  deleteProjectService(id: string): Promise<void>;
  projectActivity(projectId: string): Promise<AuditEntry[]>;

  /** The credential vault's wrapped key, or null before a passphrase is set. */
  vault(): Promise<VaultConfig | null>;
  createVault(v: VaultConfig): Promise<void>;
  updateVault(v: VaultConfig): Promise<void>;
  /** Forgotten passphrase: delete every saved credential and the vault. */
  resetVault(): Promise<void>;
  credentials(projectId: string): Promise<Credential[]>;
  credentialCount(): Promise<number>;
  saveCredential(c: CredentialInput, isNew: boolean): Promise<void>;
  deleteCredential(id: string): Promise<void>;

  subscribe(cb: (e: ChangeEvent) => void): () => void;

  /** Recent reports (about four months), newest send first. Light columns only. */
  reports(): Promise<ReportRow[]>;
  report(id: string): Promise<Report | null>;
  reportFiles(id: string): Promise<ReportFile[]>;
  /** The client PDF's pages as image sources, in order. */
  reportPages(id: string): Promise<ReportPage[]>;
  /** A PDF as base64, or null if it hasn't been rendered. */
  reportPdf(id: string, kind: "client" | "internal"): Promise<string | null>;
  reportActivity(id: string): Promise<AuditEntry[]>;
  updateReport(id: string, patch: ReportPatch): Promise<void>;
  /** Move these reports from one status to another (Hold all, Resume all). Returns how many moved. */
  moveReports(ids: string[], from: ReportStatus, to: ReportStatus): Promise<number>;
  /** Archive finished reports (take them off the Reports list), or restore them. Returns how many changed. */
  clearReports(ids: string[], cleared: boolean): Promise<number>;
  deleteReport(id: string): Promise<void>;
  /** Delete reports for good (with their PDFs). Returns how many were deleted. */
  deleteReports(ids: string[]): Promise<number>;
  /** Send now, Send me a copy (to Henry only, changes nothing), re-render the PDFs after an edit, or check the client's UniFi now (report-action Edge Function). */
  reportAction(id: string, action: "render" | "rebuild" | "send_now" | "unifi" | "copy"): Promise<{ started: "render" | "send" | "unifi" | "copy" | null }>;
  /** A client's latest UniFi status (saved by the reports repo), or null if never checked. */
  unifiStatus(clientId: string): Promise<UnifiStatus | null>;
  reportSettings(): Promise<ReportSettings>;
  saveReportSettings(patch: Partial<Omit<ReportSettings, "updated_at">>): Promise<void>;
  /** Called on any change to reports; refetch what you show. */
  subscribeReports(cb: () => void): () => void;

  // Outgoing quotes ("Quotes"; proposals in the database)
  createLead(l: { name: string; company: string | null; email: string; phone: string | null }): Promise<string>;
  proposals(): Promise<ProposalRow[]>;
  proposal(id: string): Promise<Proposal | null>;
  createProposal(p: ProposalInput): Promise<string>;
  /** Save edits (autosave). Fails when the database says the quote is locked. */
  updateProposal(id: string, patch: Partial<ProposalInput> & { archived_at?: string | null }): Promise<void>;
  deleteProposal(id: string): Promise<void>;
  proposalEvents(id: string): Promise<ProposalEvent[]>;
  /** Recent events on every quote, newest first (the Overview's activity). */
  recentProposalEvents(limit: number): Promise<ProposalEvent[]>;
  proposalVersions(id: string): Promise<ProposalVersion[]>;
  proposalAcceptances(id: string): Promise<ProposalAcceptance[]>;
  /** The buttons that change a quote's status, each a database function that checks you're the admin. */
  proposalRpc(fn: ProposalFn, args: Record<string, unknown>): Promise<unknown>;
  /** Send now, Resend, Send me a test, Payments status and test payment (the quote-action Edge Function). */
  quoteAction(body: { action: "send" | "resend" | "test"; id: string; subject: string; note: string } | { action: "status" | "test_payment" }): Promise<Record<string, unknown>>;
  templates(): Promise<ProposalTemplate[]>;
  saveTemplate(t: Omit<ProposalTemplate, "id" | "created_at" | "updated_at">, id?: string): Promise<string>;
  deleteTemplate(id: string): Promise<void>;
  quoteSettings(): Promise<QuoteSettings>;
  saveQuoteSettings(patch: Partial<Omit<QuoteSettings, "stripe_mode" | "stripe_checked_at" | "cron_seen_at" | "updated_at">>): Promise<void>;
  payments(): Promise<Payment[]>;
  /** Called on any change to quotes or their timelines. */
  subscribeProposals(cb: () => void): () => void;

  // Prospecting: outbound security audits
  prospects(): Promise<Prospect[]>;
  prospect(id: string): Promise<Prospect | null>;
  createProspect(p: ProspectInput): Promise<string>;
  updateProspect(id: string, patch: Partial<ProspectInput>): Promise<void>;
  deleteProspect(id: string): Promise<void>;
  archiveProspect(id: string, archived: boolean): Promise<void>;
  /** Bulk add from a CSV import; returns how many were newly added (duplicates by domain are skipped). */
  importProspects(rows: ProspectInput[]): Promise<number>;
  prospectNotes(id: string): Promise<ProspectNote[]>;
  addProspectNote(prospectId: string, body: string): Promise<void>;
  deleteProspectNote(id: string): Promise<void>;
  prospectActivity(id: string): Promise<AuditEntry[]>;
  /** Turn a prospect into a sales lead; returns the lead id. */
  convertProspect(id: string): Promise<string>;

  /** Recent audits (light columns only), newest first. */
  audits(): Promise<AuditRow[]>;
  auditsFor(prospectId: string): Promise<AuditRow[]>;
  audit(id: string): Promise<Audit | null>;
  /** The prospect-facing PDF's pages as image sources, in order. */
  auditPages(id: string): Promise<ReportPage[]>;
  /** A PDF as base64, or null if it hasn't been rendered. */
  auditPdf(id: string, kind: "client" | "internal"): Promise<string | null>;
  auditActivity(id: string): Promise<AuditEntry[]>;
  updateAudit(id: string, patch: AuditPatch): Promise<void>;
  deleteAudit(id: string): Promise<void>;
  /** Queue a new audit for a prospect (active needs a live authorization); returns the audit id. */
  startAudit(prospectId: string, kind: AuditKind, isTest: boolean): Promise<string>;
  /** Start the scan, re-render the PDFs, send now, or send me a copy (the audit-action Edge Function). */
  auditAction(id: string, action: AuditAction): Promise<{ started: "scan" | "render" | "send" | "copy" | null }>;
  /** Queue passive scans for many prospects at once; returns how many were queued. With ids null,
   *  every eligible prospect that has never been audited; rescan re-queues even ones already done. */
  scanProspects(ids: string[] | null, rescan: boolean): Promise<number>;
  /** Dispatch one scan run that drains the whole queue (call after scanProspects). */
  scanQueue(): Promise<void>;

  authorizations(prospectId: string): Promise<AuditAuthorization[]>;
  addAuthorization(a: AuthorizationInput): Promise<void>;
  setAuthorizationRevoked(id: string, revoked: boolean): Promise<void>;
  deleteAuthorization(id: string): Promise<void>;

  auditSettings(): Promise<AuditSettings>;
  saveAuditSettings(patch: Partial<Omit<AuditSettings, "updated_at">>): Promise<void>;
  /** Find local businesses and queue them as prospects (the discover Edge Function). */
  discoverProspects(params: DiscoverParams): Promise<{ found: number; added: number }>;
  /** Run a passive scan of one URL and return a provisional grade and findings, adding nothing (the quick-scan Edge Function). */
  quickScan(url: string): Promise<QuickScanResult>;
  /** Save a quick-scan result as a prospect's completed audit (no re-scan); returns the audit id. */
  saveQuickAudit(prospectId: string, result: QuickScanResult): Promise<string>;
  /** Called on any change to prospects or audits; refetch what you show. */
  subscribeProspecting(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Outgoing quotes
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUSES = ["draft", "scheduled", "sent", "viewed", "changes_requested", "accepted", "declined", "expired", "revoked"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** Sent and waiting on the client. */
export const OPEN_PROPOSAL_STATUSES: readonly ProposalStatus[] = ["sent", "viewed", "changes_requested"];

export type ProposalFn = "proposal_schedule" | "proposal_unschedule" | "proposal_revise" | "proposal_discard_revision" | "proposal_revoke" | "proposal_new_link"
  | "proposal_set_declined" | "proposal_duplicate" | "proposal_convert" | "proposal_publish";

export type ProposalRow = {
  id: string;
  number: number;
  created_at: string;
  updated_at: string;
  lead_id: string | null;
  client_id: string | null;
  title: string;
  status: ProposalStatus;
  recipient_name: string;
  recipient_email: string | null;
  cc: string[];
  prepared_on: string;
  valid_until: string;
  /** The working draft (see supabase/functions/_shared/proposal.ts). */
  content: import("../../../supabase/functions/_shared/proposal.ts").ProposalDoc;
  token: string;
  version: number;
  revising: boolean;
  /** The latest version was published without an email, and none has gone since. Set by the database. */
  link_only: boolean;
  scheduled_at: string | null;
  send_subject: string | null;
  send_note: string | null;
  reminders: boolean;
  sent_at: string | null;
  last_sent_at: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  changes_requested_at: string | null;
  accepted_at: string | null;
  accepted_version: number | null;
  accepted_once: number | null;
  accepted_monthly: number | null;
  archived_at: string | null;
};

export type Proposal = ProposalRow & {
  internal: import("../../../supabase/functions/_shared/proposal.ts").ProposalInternal;
  internal_notes: string | null;
};

export type ProposalInput = Pick<Proposal, "lead_id" | "client_id" | "title" | "recipient_name" | "recipient_email" | "cc" | "prepared_on" | "valid_until" | "content" | "internal" | "internal_notes" | "reminders">;

export type ProposalEvent = {
  id: number;
  proposal_id: string;
  at: string;
  kind: string;
  detail: Record<string, unknown>;
  notify: string | null;
  notified_at: string | null;
};

export type ProposalVersion = {
  id: string;
  proposal_id: string;
  version: number;
  sent_at: string;
  header: { number: string; title: string; prepared_for: string; prepared_on: string; valid_until: string };
  content: import("../../../supabase/functions/_shared/proposal.ts").ProposalDoc;
};

export type ProposalAcceptance = {
  id: string;
  proposal_id: string;
  version: number;
  accepted_at: string;
  tier: string;
  addons: string[];
  lines: { key: string; name: string; billing: "once" | "monthly"; list: number; price: number; net: number; kind: string }[];
  once_total: number;
  monthly_total: number;
  due_now: number;
  signer_name: string;
  signer_title: string;
  signer_email: string;
  signature: string;
  doc: import("../../../supabase/functions/_shared/proposal.ts").ProposalDoc;
};

export type ProposalTemplate = {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  title: string;
  content: import("../../../supabase/functions/_shared/proposal.ts").ProposalDoc;
  internal: import("../../../supabase/functions/_shared/proposal.ts").ProposalInternal;
};

export type QuoteSettings = {
  notify_email: string;
  reply_to: string;
  from_name: string;
  default_valid_days: number;
  remind_unviewed_days: number;
  remind_expiry_days: number;
  stripe_mode: "off" | "test" | "live";
  stripe_checked_at: string | null;
  cron_seen_at: string | null;
  updated_at: string;
};

export type Payment = {
  id: string;
  created_at: string;
  proposal_id: string | null;
  acceptance_id: string | null;
  project_id: string | null;
  kind: "deposit" | "full" | "balance" | "test";
  amount: number;
  status: "pending" | "paid" | "failed" | "expired" | "refunded";
  livemode: boolean;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  paid_at: string | null;
};

export type Unit = "dev" | "mo" | "once" | "devonce";

export type PackageId = "essential" | "secure" | "shield";
/** Homepage package; rates are per device per month for 1-24, 25-49, 50-99 and 100+ devices. */
export type PackageRow = { id: PackageId; name: string; rates: number[]; sort: number };
export const RATE_TIERS = ["1 to 24", "25 to 49", "50 to 99", "100+"] as const;

export type ServiceCategory = { id: string; name: string; blurb: string; sort: number };

export type ServiceRow = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price: number;
  unit: Unit;
  price_from: boolean;
  in_packages: boolean;
  active: boolean;
  locked: boolean;
  sort: number;
};

export const CLIENT_STATUSES = ["active", "paused", "former"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export type Client = {
  id: string;
  created_at: string;
  updated_at: string;
  company: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: ClientStatus;
  started_on: string | null;
  workstations: number;
  servers: number;
  notes: string | null;
  lead_id: string | null;
  /** Patch reports: the client's Action1 group, who gets them, and whether they are on. */
  action1_group: string | null;
  report_recipients: string[];
  report_cc: string[];
  reports_enabled: boolean;
  /** Computers to always leave off this client's reports, by the name shown on the report. */
  report_exclude: string[];
  /** The client's UniFi console, as UniFi Site Manager names it (or its host id), for router info on reports. */
  unifi_console: string | null;
};

type ReportFields = "action1_group" | "report_recipients" | "report_cc" | "reports_enabled" | "report_exclude" | "unifi_console";
export type ClientInput = Omit<Client, "id" | "created_at" | "updated_at" | ReportFields> & Partial<Pick<Client, ReportFields>>;

/** A priced service on a client or project. */
export type ServiceLine = {
  id: string;
  service_id: string | null;
  name: string;
  billing: "monthly" | "once";
  /** Price per unit; amount = unit_amount x quantity (kept in sync by the database). */
  unit_amount: number;
  quantity: number;
  amount: number;
  notes: string | null;
  sort: number;
};
export type ClientService = ServiceLine & { client_id: string };

export const PROJECT_STATUSES = ["potential", "proposed", "in_progress", "on_hold", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const OPEN_PROJECT_STATUSES: readonly ProjectStatus[] = ["potential", "proposed", "in_progress", "on_hold"];

export type Project = {
  id: string;
  created_at: string;
  updated_at: string;
  /** Exactly one of these is set. A lead's projects move to its client on conversion. */
  lead_id: string | null;
  client_id: string | null;
  name: string;
  status: ProjectStatus;
  due_on: string | null;
  notes: string | null;
  /** The quote this project was made from, if any. */
  proposal_id?: string | null;
};

export type ProjectInput = Omit<Project, "id" | "created_at" | "updated_at" | "proposal_id">;
export type ProjectService = ServiceLine & { project_id: string };

/** The data key, wrapped under the vault passphrase (see lib/crypto.ts). */
export type VaultConfig = { salt: string; iterations: number; wrapped_key: string };

/** A saved login. Only the label is readable; secret is ciphertext made in the browser. */
export type Credential = {
  id: string;
  project_id: string;
  label: string;
  secret: string;
  sort: number;
  created_at: string;
  updated_at: string;
};
export type CredentialInput = Pick<Credential, "id" | "project_id" | "label" | "secret" | "sort">;

export type ToastMsg = { id: number; tone: "info" | "success" | "error"; title?: string; body: string; href?: string; /** The words of the link, when there is an href. */ link?: string };

// ---------------------------------------------------------------------------
// Patch reports (made in the cyberxla-patch-reports repo, edited here)
// ---------------------------------------------------------------------------

export const REPORT_STATUSES = ["scheduled", "held", "sending", "sent", "failed", "cancelled"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportPeriod = "weekly" | "monthly";

export type ReportSettings = {
  mode: "preview" | "live";
  auto_send_default: boolean;
  /** "12:00:00", Pacific */
  generate_time: string;
  send_time: string;
  sunday_review_email: boolean;
  /** The report template as saved; blank parts mean the defaults (see lib/template.ts). */
  template: Partial<ReportTemplate>;
  updated_at: string;
};

/** Wording for one period. Text may use **bold** and {placeholders}. */
export type ReportTemplatePeriod = {
  label: string;
  subtitle: string;
  headline: string;
  kpi_labels: string[];
  weeks_title?: string;
  did_title: string;
  columns: string[];
  updates_title: string;
  subject: string;
  body: string;
};

/** The wording and order every new report starts from (lib/template.js in the reports repo). */
export type ReportTemplate = {
  v: 1;
  did_items: { title: string; text: string }[];
  pill_clear: string;
  pill_attention: string;
  computers_title: string;
  updates_empty_ok: string;
  updates_empty_failed: string;
  security_title: string;
  security_text: string;
  apps_intro: string;
  security_note: string;
  next_label: string;
  next_when: string;
  next_note: string;
  /** Only on reports for a period when one of the client's UniFi devices was updated; then every device is listed. */
  network_title: string;
  router_update_title: string;
  router_update_text: string;
  device_update_title: string;
  device_update_text: string;
  /** A device listed in that section that was not updated this period and is up to date. */
  device_checked_title: string;
  device_checked_text: string;
  /** The same, when UniFi shows an update waiting for it. */
  device_waiting_title: string;
  device_waiting_text: string;
  weekly: ReportTemplatePeriod;
  monthly: ReportTemplatePeriod;
};

export const TONES = ["good", "warn", "bad", "info", "lime"] as const;
export type Tone = (typeof TONES)[number];

/** One computer: its row in "Your computers" and its card in "Updates installed". */
export type ReportComputer = {
  /** Action1's id for the computer (reports made since Nov 15, 2026): the internal PDF uses it to follow edits here. Absent on computers added by hand. */
  id?: string;
  name: string;
  /** The computer's own (Windows) name, shown smaller after the name. Blank hides it. */
  host?: string;
  /** Weekly: Success, Failed or No result. Monthly: "4 of 5". */
  run: string;
  pending: string;
  crit: string;
  status: string;
  tone: Tone;
  hidden: boolean;
  /** failed: updates that did not install (reports made before Nov 2026 have none). */
  updates: { count: number; items: { name: string; count: number; severity: string | null }[]; failed?: { name: string }[]; empty: string };
};

/** One UniFi device as the Check UniFi status job saves it (lib/unifi.js statusData in the reports repo). */
export type UnifiDevice = {
  name: string;
  model: string;
  isConsole: boolean;
  /** The UniFi Network app on the router (software, not a device: it has no restart time). */
  isApp?: boolean;
  status: string;
  online: boolean;
  version: string;
  needsUpdate: boolean;
  updateAvailable: string | null;
  startupTime: string | null;
  /** The last software update the checks have seen. */
  lastUpdate: { from: string; to: string; at: string } | null;
  /** When the checks first saw this device: no update before this is known. */
  trackedSince: string | null;
};

export type UnifiStatus = {
  client_id: string;
  console: string;
  checked_at: string;
  data: { v: number; found: boolean; error: string | null; console: string; router: UnifiDevice | null; devices: UnifiDevice[] };
};

/**
 * Every client facing string in the PDF (lib/content.js in the reports repo).
 * Text may use **bold**. Labels the PDF shows in capitals are stored in normal case.
 */
export type ReportContent = {
  v: 1;
  period: ReportPeriod;
  doc_title: string;
  label: string;
  title: string;
  subtitle: string;
  headline: string;
  pill: { text: string; tone: Tone };
  kpis: { value: string; label: string; note?: string | null; highlight?: boolean }[];
  weeks: { title: string; bars: { pct: number; label: string; sub: string }[] } | null;
  did: { title: string; items: { title: string; text: string }[] };
  /** Optional one-off section (a router replaced, a new computer set up), added by hand. Prints first on page 2. */
  extra?: { title: string; items: { title: string; text: string }[] } | null;
  /** UniFi devices updated this period (router first); after the updates, as a dark card. */
  network?: { title: string; items: { title: string; text: string }[] } | null;
  computers: { title: string; columns: { key: string; label: string }[]; list: ReportComputer[] };
  updates_title: string;
  security: { title: string; text: string; apps_intro: string; apps: { name: string; detail: string }[]; note: string };
  next_window: { label: string; when: string; note: string };
};

/** A report as listed (no content). */
export type ReportRow = {
  id: string;
  created_at: string;
  updated_at: string;
  client_id: string;
  client_name: string;
  period: ReportPeriod;
  /** 2026-W45 or 2026-10 */
  period_key: string;
  period_start: string;
  period_end: string;
  is_test: boolean;
  status: ReportStatus;
  send_at: string;
  recipients: string[];
  cc: string[];
  subject: string;
  failure_count: number;
  warnings: string[];
  content_version: number;
  rendered_version: number;
  rendered_at: string | null;
  render_error: string | null;
  claimed_at: string | null;
  attempts: number;
  sent_at: string | null;
  error: string | null;
  /** When it was archived (off the Reports list, still kept); null when on the list. */
  cleared_at: string | null;
};

export type Report = ReportRow & {
  email_body: string;
  content: ReportContent;
  /** As generated, for Reset to generated. */
  original: { content: ReportContent; subject: string; email_body: string };
};

export type ReportPatch = Partial<Pick<Report, "status" | "send_at" | "recipients" | "cc" | "subject" | "email_body" | "content">>;
export type ReportFile = { kind: "client" | "internal" | "page"; page: number; version: number; size: number; created_at: string };
/** src is a data: URL (or a bundled image in the demo). */
export type ReportPage = { page: number; version: number; src: string };

// ---------------------------------------------------------------------------
// Prospecting: find local businesses, audit their public security posture, and
// send a branded report. The schema and rules live in
// supabase/migrations/0023_prospecting.sql; the scanner runs in GitHub Actions.
// ---------------------------------------------------------------------------

export const PROSPECT_STATUSES = ["new", "auditing", "audited", "contacted", "responded", "converted", "declined"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const OPEN_PROSPECT_STATUSES: readonly ProspectStatus[] = ["new", "auditing", "audited", "contacted", "responded"];
export const PROSPECT_SOURCES = ["manual", "csv", "yelp", "google_places", "import"] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

export type Prospect = {
  id: string;
  created_at: string;
  updated_at: string;
  business_name: string;
  /** The site we audit. */
  website: string | null;
  /** The normalized apex domain, for DNS checks and de-duplication. */
  domain: string | null;
  contact_name: string | null;
  /** Where an audit would be sent. Null until we find one. */
  email: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  industry: string | null;
  status: ProspectStatus;
  source: ProspectSource;
  source_ref: string | null;
  /** Set when the prospect is turned into a sales lead. */
  lead_id: string | null;
  notes: string | null;
  archived_at: string | null;
};
export type ProspectInput = Omit<Prospect, "id" | "created_at" | "updated_at" | "status" | "lead_id" | "archived_at"> & { status?: ProspectStatus };

export type ProspectNote = { id: string; prospect_id: string; created_at: string; body: string };

export const AUDIT_KINDS = ["passive", "active"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_SCAN_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type AuditScanStatus = (typeof AUDIT_SCAN_STATUSES)[number];
export const AUDIT_DELIVERY_STATUSES = ["none", "sending", "sent", "failed"] as const;
export type AuditDelivery = (typeof AUDIT_DELIVERY_STATUSES)[number];
export const AUDIT_GRADES = ["A", "B", "C", "D", "E", "F"] as const;
export type AuditGrade = (typeof AUDIT_GRADES)[number];
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
/** What a finding points at, used to group findings and map them to a cyberxLA service. */
export const FINDING_CATEGORIES = ["tls", "headers", "email", "cookies", "software", "exposure", "dns", "privacy"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type AuditAction = "scan" | "rescan" | "rebuild" | "send_now" | "copy" | "cancel";

/** One observation from a scan. The shape is shared with the runner (scanner/lib). */
export type AuditFinding = {
  id: string;
  category: FindingCategory | string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence?: string | null;
  recommendation?: string | null;
  /** Maps the finding to a cyberxLA service, for the pitch. */
  service?: string | null;
  /** A check that passed, shown as a positive rather than a problem. */
  passed?: boolean;
};

/** An audit as listed (no findings or scan metadata). */
export type AuditRow = {
  id: string;
  created_at: string;
  updated_at: string;
  prospect_id: string;
  kind: AuditKind;
  is_test: boolean;
  scan_status: AuditScanStatus;
  target_url: string | null;
  target_domain: string | null;
  grade: AuditGrade | null;
  score: number | null;
  summary: string | null;
  scanner_version: string | null;
  started_at: string | null;
  finished_at: string | null;
  scan_error: string | null;
  attempts: number;
  authorization_id: string | null;
  content_version: number;
  rendered_version: number;
  rendered_at: string | null;
  render_error: string | null;
  delivery: AuditDelivery;
  recipients: string[];
  subject: string | null;
  sent_at: string | null;
  send_error: string | null;
};
export type Audit = AuditRow & {
  findings: AuditFinding[];
  meta: Record<string, unknown>;
  email_body: string | null;
};
export type AuditPatch = Partial<Pick<Audit, "subject" | "email_body" | "recipients" | "findings" | "grade" | "score" | "summary">>;

export const AUTH_METHODS = ["signed_doc", "contract", "email", "verbal_recorded"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
/** A recorded authorization: the gate an active (intrusive) audit needs. */
export type AuditAuthorization = {
  id: string;
  created_at: string;
  prospect_id: string;
  domain: string;
  scope: string;
  method: AuthMethod;
  authorized_by_name: string;
  authorized_by_title: string | null;
  authorized_by_email: string;
  evidence: string | null;
  signed_on: string;
  expires_on: string;
  revoked_at: string | null;
};
export type AuthorizationInput = Omit<AuditAuthorization, "id" | "created_at" | "revoked_at">;

export type AuditSettings = {
  /** preview: audit emails go to henry@cyberx.la only. live: they go to the prospect. */
  mode: "preview" | "live";
  passive_enabled: boolean;
  active_enabled: boolean;
  sender_email: string;
  sender_name: string;
  reply_to: string;
  default_subject: string;
  default_body: string;
  updated_at: string;
};

export type DiscoverParams = { term: string; location: string; limit: number; source: "yelp" | "google_places" };

/** The result of a manual Quick scan of one URL (the quick-scan Edge Function). */
export type QuickScanResult = {
  reachable: boolean;
  domain: string;
  target: string;
  grade: AuditGrade | null;
  score: number | null;
  summary: string | null;
  findings: AuditFinding[];
  checked_at: string;
  notes: string[];
};
