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
    | "projects" | "project_services" | "project_credentials" | "reports" | "report_settings";
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
  deleteReport(id: string): Promise<void>;
  /** Send now, or re-render the PDFs after an edit (report-action Edge Function). */
  reportAction(id: string, action: "render" | "rebuild" | "send_now"): Promise<{ started: "render" | "send" | null }>;
  reportSettings(): Promise<ReportSettings>;
  saveReportSettings(patch: Partial<Omit<ReportSettings, "updated_at">>): Promise<void>;
  /** Called on any change to reports; refetch what you show. */
  subscribeReports(cb: () => void): () => void;
}

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
};

type ReportFields = "action1_group" | "report_recipients" | "report_cc" | "reports_enabled" | "report_exclude";
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
};

export type ProjectInput = Omit<Project, "id" | "created_at" | "updated_at">;
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

export type ToastMsg = { id: number; title: string; body: string; href?: string };

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
  weekly: ReportTemplatePeriod;
  monthly: ReportTemplatePeriod;
};

export const TONES = ["good", "warn", "bad", "info", "lime"] as const;
export type Tone = (typeof TONES)[number];

/** One computer: its row in "Your computers" and its card in "Updates installed". */
export type ReportComputer = {
  name: string;
  /** Weekly: Success, Failed or No result. Monthly: "4 of 5". */
  run: string;
  pending: string;
  crit: string;
  status: string;
  tone: Tone;
  hidden: boolean;
  updates: { count: number; items: { name: string; count: number; severity: string | null }[]; empty: string };
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
