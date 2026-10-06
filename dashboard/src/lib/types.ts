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
  table_name: "leads" | "quotes" | "lead_notes";
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
  deleteQuote(id: string): Promise<void>;
  hideActivity(auditId: number, hidden: boolean): Promise<void>;
  subscribe(cb: (e: ChangeEvent) => void): () => void;
}

export type ToastMsg = { id: number; title: string; body: string; href?: string };
