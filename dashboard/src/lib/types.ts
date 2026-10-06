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
  table_name: "leads" | "quotes" | "lead_notes" | "clients" | "client_services" | "services" | "service_categories";
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

  subscribe(cb: (e: ChangeEvent) => void): () => void;
}

export type Unit = "dev" | "mo" | "once" | "devonce";

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
};

export type ClientInput = Omit<Client, "id" | "created_at" | "updated_at">;

export type ClientService = {
  id: string;
  client_id: string;
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

export type ToastMsg = { id: number; title: string; body: string; href?: string };
