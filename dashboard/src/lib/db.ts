// Supabase implementation of Db. Every query runs as the signed-in user, so the
// database's row-level security decides what comes back: nothing at all unless
// the user is on the admin allowlist AND finished MFA this session.
import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";
import { priceQuote } from "./catalog.ts";
import { catalog } from "./store.svelte.ts";
import type { AuditEntry, AuthState, ChangeEvent, Client, ClientService, Credential, Db, Enrollment, Lead, LeadStatus, Note, PackageRow, Project, ProjectService, Quote, QuoteStatus, Report, ReportFile, ReportRow, ReportSettings, ServiceLine, ServiceRow, VaultConfig } from "./types.ts";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

const sb: SupabaseClient = createClient(url, key, {
  auth: {
    // Session lives only as long as this browser tab session.
    storage: window.sessionStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (e: { message: string } | null) => {
  if (e) throw new Error(e.message);
};

async function resolveState(): Promise<AuthState> {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { step: "signed-out" };
  const email = session.user.email ?? "";

  const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  fail(error);
  if (aal!.currentLevel !== "aal2") {
    const { data: factors, error: fe } = await sb.auth.mfa.listFactors();
    fail(fe);
    const totp = factors!.totp.find((f) => f.status === "verified");
    return totp ? { step: "mfa", email, factorId: totp.id } : { step: "enroll", email };
  }

  // MFA done. Confirm this account is on the admin allowlist.
  const { data: me, error: ae } = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
  fail(ae);
  return me ? { step: "ready", email } : { step: "denied", email };
}

const db: Db = {
  demo: false,

  authState: resolveState,

  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error("Email or password is incorrect.");
    return resolveState();
  },

  async enrollTotp(): Promise<Enrollment> {
    // Clear any half-finished enrollment first.
    const { data: factors } = await sb.auth.mfa.listFactors();
    for (const f of factors?.all ?? []) {
      if (f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app", issuer: "cyberxLA Admin" });
    fail(error);
    return { factorId: data!.id, qr: data!.totp.qr_code, secret: data!.totp.secret };
  },

  async verifyTotp(factorId, code) {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw new Error("That code didn't work. Check the time on your phone and try the newest code.");
    return resolveState();
  },

  async signOut() {
    await sb.removeAllChannels();
    await sb.auth.signOut({ scope: "local" });
    window.sessionStorage.clear();
  },

  onSignedOut(cb) {
    sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") cb();
    });
  },

  async leads() {
    const { data, error } = await sb.from("leads").select("*").order("updated_at", { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []).map(normLead);
  },

  async quotes() {
    const { data, error } = await sb.from("quotes").select("*").order("created_at", { ascending: false }).limit(10000);
    fail(error);
    return (data ?? []).map(normQuote);
  },

  async lead(id) {
    const { data, error } = await sb.from("leads").select("*").eq("id", id).maybeSingle();
    fail(error);
    return data ? normLead(data) : null;
  },

  async quotesFor(leadId) {
    const { data, error } = await sb.from("quotes").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
    fail(error);
    return (data ?? []).map(normQuote);
  },

  async notesFor(leadId) {
    const { data, error } = await sb.from("lead_notes").select("id, lead_id, created_at, body").eq("lead_id", leadId).order("created_at", { ascending: false });
    fail(error);
    return (data ?? []) as Note[];
  },

  async allNotes() {
    const { data, error } = await sb.from("lead_notes").select("id, lead_id, created_at, body").order("created_at").limit(20000);
    fail(error);
    return (data ?? []) as Note[];
  },

  async activityFor(leadId) {
    if (!UUID.test(leadId)) return [];
    const { data, error } = await sb
      .from("audit_log")
      .select("*")
      .or(`row_id.eq.${leadId},new_data->>lead_id.eq.${leadId},old_data->>lead_id.eq.${leadId}`)
      .order("at", { ascending: false })
      .limit(200);
    fail(error);
    const { data: hidden, error: he } = await sb.from("activity_hidden").select("audit_id");
    fail(he);
    const hiddenIds = new Set((hidden ?? []).map((h) => Number(h.audit_id)));
    return ((data ?? []) as AuditEntry[]).map((a) => ({ ...a, hidden: hiddenIds.has(Number(a.id)) }));
  },

  async setLeadStatus(id: string, status: LeadStatus) {
    const { error } = await sb.from("leads").update({ status }).eq("id", id);
    fail(error);
  },

  async setQuoteStatus(id: string, status: QuoteStatus) {
    const { error } = await sb.from("quotes").update({ status }).eq("id", id);
    fail(error);
  },

  async addNote(leadId, body) {
    const { error } = await sb.from("lead_notes").insert({ lead_id: leadId, body });
    fail(error);
  },

  async deleteNote(id) {
    const { error, count } = await sb.from("lead_notes").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async archiveLead(id, archived) {
    const { error } = await sb.from("leads").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
    fail(error);
  },

  async deleteLead(id) {
    const { error, count } = await sb.from("leads").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async archiveQuote(id, archived) {
    const { error } = await sb.from("quotes").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
    fail(error);
  },

  async updateQuoteServices(id, serviceIds, workstations, servers) {
    if (!serviceIds.length) throw new Error("A quote needs at least one service. Delete the quote instead.");
    const priced = priceQuote(catalog.services, serviceIds, workstations, servers);
    const { error, count } = await sb
      .from("quotes")
      .update({ workstations, servers, ...priced }, { count: "exact" })
      .eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async deleteQuote(id) {
    const { error, count } = await sb.from("quotes").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async hideActivity(auditId, hidden) {
    const { error } = hidden
      ? await sb.from("activity_hidden").insert({ audit_id: auditId })
      : await sb.from("activity_hidden").delete().eq("audit_id", auditId);
    fail(error);
  },

  async categories() {
    const { data, error } = await sb.from("service_categories").select("id, name, blurb, sort").order("sort").order("name");
    fail(error);
    return data ?? [];
  },

  async services() {
    const { data, error } = await sb.from("services")
      .select("id, category_id, name, description, price, unit, price_from, in_packages, active, locked, sort")
      .order("sort").order("name");
    fail(error);
    return (data ?? []).map((r) => ({ ...(r as ServiceRow), price: Number(r.price) }));
  },

  async saveCategory(c, isNew) {
    const row = { name: c.name.trim(), blurb: c.blurb.trim(), sort: c.sort };
    const { error } = isNew
      ? await sb.from("service_categories").insert({ id: c.id, ...row })
      : await sb.from("service_categories").update(row).eq("id", c.id);
    fail(friendly(error));
  },

  async deleteCategory(id) {
    const { error } = await sb.from("service_categories").delete().eq("id", id);
    fail(friendly(error));
  },

  async saveService(s, isNew) {
    const row = {
      category_id: s.category_id, name: s.name.trim(), description: s.description.trim(), price: s.price,
      unit: s.unit, price_from: s.price_from, in_packages: s.in_packages, active: s.active, sort: s.sort,
    };
    const { error } = isNew
      ? await sb.from("services").insert({ id: s.id, ...row })
      : await sb.from("services").update(row).eq("id", s.id);
    fail(friendly(error));
  },

  async deleteService(id) {
    const { error, count } = await sb.from("services").delete({ count: "exact" }).eq("id", id);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async packages() {
    const { data, error } = await sb.from("packages").select("id, name, rates, sort").order("sort");
    fail(error);
    return (data ?? []).map((r) => ({ ...(r as PackageRow), rates: (r.rates as unknown[]).map(Number) }));
  },

  async savePackageRates(id, rates) {
    const { error, count } = await sb.from("packages").update({ rates }, { count: "exact" }).eq("id", id);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async reorder(table, ids) {
    // A handful of rows; one small update each.
    for (const [i, id] of ids.entries()) {
      const { error } = await sb.from(table).update({ sort: i * 10 }).eq("id", id);
      fail(friendly(error));
    }
  },

  async clients() {
    const { data, error } = await sb.from("clients").select("*").order("updated_at", { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []) as Client[];
  },

  async client(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("clients").select("*").eq("id", id).maybeSingle();
    fail(error);
    return (data as Client) ?? null;
  },

  async allClientServices() {
    const { data, error } = await sb.from("client_services").select("*").limit(20000);
    fail(error);
    return (data ?? []).map(normLine<ClientService>);
  },

  async clientServices(clientId) {
    const { data, error } = await sb.from("client_services").select("*").eq("client_id", clientId).order("sort").order("created_at");
    fail(error);
    return (data ?? []).map(normLine<ClientService>);
  },

  async createClient(c) {
    const { data, error } = await sb.from("clients").insert(c).select("id").single();
    fail(friendly(error));
    return (data as { id: string }).id;
  },

  async updateClient(id, patch) {
    const { error } = await sb.from("clients").update(patch).eq("id", id);
    fail(friendly(error));
  },

  async deleteClient(id) {
    const { error, count } = await sb.from("clients").delete({ count: "exact" }).eq("id", id);
    // Only reports block this (everything else goes with the client).
    if (error?.code === "23503") throw new Error("This client has patch reports, which are kept for the record. Set their status to Former instead.");
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async addClientService(s) {
    const { error } = await sb.from("client_services").insert(s);
    fail(friendly(error));
  },

  async updateClientService(id, patch) {
    const { error } = await sb.from("client_services").update(patch).eq("id", id);
    fail(friendly(error));
  },

  async deleteClientService(id) {
    const { error } = await sb.from("client_services").delete().eq("id", id);
    fail(error);
  },

  clientActivity: (clientId) => activityOf("client_id", clientId),

  async convertLead(leadId) {
    const { data, error } = await sb.rpc("convert_lead_to_client", { p_lead: leadId });
    fail(error);
    return data as string;
  },

  async projects() {
    const { data, error } = await sb.from("projects").select("*").order("updated_at", { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []) as Project[];
  },

  async project(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("projects").select("*").eq("id", id).maybeSingle();
    fail(error);
    return (data as Project) ?? null;
  },

  async allProjectServices() {
    const { data, error } = await sb.from("project_services").select("*").limit(20000);
    fail(error);
    return (data ?? []).map(normLine<ProjectService>);
  },

  async projectServices(projectId) {
    const { data, error } = await sb.from("project_services").select("*").eq("project_id", projectId).order("sort").order("created_at");
    fail(error);
    return (data ?? []).map(normLine<ProjectService>);
  },

  async createProject(p) {
    const { data, error } = await sb.from("projects").insert(p).select("id").single();
    fail(ownerGone(error));
    return (data as { id: string }).id;
  },

  async updateProject(id, patch) {
    const { error } = await sb.from("projects").update(patch).eq("id", id);
    fail(ownerGone(error));
  },

  async deleteProject(id) {
    const { error, count } = await sb.from("projects").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async addProjectService(s) {
    const { error } = await sb.from("project_services").insert(s);
    fail(friendly(error));
  },

  async updateProjectService(id, patch) {
    const { error } = await sb.from("project_services").update(patch).eq("id", id);
    fail(friendly(error));
  },

  async deleteProjectService(id) {
    const { error } = await sb.from("project_services").delete().eq("id", id);
    fail(error);
  },

  projectActivity: (projectId) => activityOf("project_id", projectId),

  async vault() {
    const { data, error } = await sb.from("credential_vault").select("salt, iterations, wrapped_key").maybeSingle();
    fail(error);
    return (data as VaultConfig) ?? null;
  },

  async createVault(v) {
    const { error } = await sb.from("credential_vault").insert({ id: 1, ...v });
    if (error?.code === "23505") throw new Error("A vault was just set up in another tab. Reload this page and unlock it with that passphrase.");
    fail(error);
  },

  async updateVault(v) {
    const { error, count } = await sb.from("credential_vault").update(v, { count: "exact" }).eq("id", 1);
    fail(error);
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async resetVault() {
    const { error } = await sb.rpc("reset_credential_vault");
    fail(error);
  },

  async credentials(projectId) {
    const { data, error } = await sb.from("project_credentials").select("id, project_id, label, secret, sort, created_at, updated_at")
      .eq("project_id", projectId).order("sort").order("created_at");
    fail(error);
    return (data ?? []) as Credential[];
  },

  async credentialCount() {
    const { count, error } = await sb.from("project_credentials").select("id", { count: "exact", head: true });
    fail(error);
    return count ?? 0;
  },

  async saveCredential(c, isNew) {
    const { error, count } = isNew
      ? await sb.from("project_credentials").insert(c, { count: "exact" })
      : await sb.from("project_credentials").update({ label: c.label, secret: c.secret, sort: c.sort }, { count: "exact" }).eq("id", c.id);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async deleteCredential(id) {
    const { error, count } = await sb.from("project_credentials").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  subscribe(cb) {
    const ch = sb
      .channel("crm")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, (p) =>
        cb({ table: "leads", type: p.eventType, row: (p.eventType === "DELETE" ? p.old : p.new) as ChangeEvent["row"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "quotes" }, (p) =>
        cb({ table: "quotes", type: p.eventType, row: (p.eventType === "DELETE" ? p.old : p.new) as ChangeEvent["row"] }))
      .subscribe();
    return () => void sb.removeChannel(ch);
  },

  async reports() {
    // About four months back is plenty for the list; older ones stay in the database.
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const { data, error } = await sb.from("reports").select(REPORT_LIST).gte("send_at", since).order("send_at", { ascending: false }).limit(500);
    fail(error);
    return (data ?? []).map(normReport);
  },

  async report(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("reports").select(`${REPORT_LIST}, email_body, content, original`).eq("id", id).maybeSingle();
    fail(error);
    return data ? (normReport(data) as Report) : null;
  },

  async reportFiles(id) {
    const { data, error } = await sb.from("report_files").select("kind, page, version, size, created_at").eq("report_id", id).order("kind").order("page");
    fail(error);
    return (data ?? []) as ReportFile[];
  },

  async reportPages(id) {
    const { data, error } = await sb.rpc("report_pages", { p_report: id });
    fail(error);
    return ((data ?? []) as { page: number; version: number; png: string }[]).map((p) => ({ page: p.page, version: p.version, src: `data:image/png;base64,${p.png}` }));
  },

  async reportPdf(id, kind) {
    const { data, error } = await sb.rpc("report_file", { p_report: id, p_kind: kind });
    fail(error);
    return (data as string | null) ?? null;
  },

  async reportActivity(id) {
    if (!UUID.test(id)) return [];
    const { data, error } = await sb.from("audit_log").select("*").eq("table_name", "reports").eq("row_id", id).order("at", { ascending: false }).limit(100);
    fail(error);
    return (data ?? []) as AuditEntry[];
  },

  async updateReport(id, patch) {
    const { error, count } = await sb.from("reports").update(patch, { count: "exact" }).eq("id", id);
    fail(reportError(error));
    if (count === 0) throw new Error("Nothing was saved. Reload the report and try again.");
  },

  async moveReports(ids, from, to) {
    if (!ids.length) return 0;
    const { error, count } = await sb.from("reports").update({ status: to }, { count: "exact" }).in("id", ids).eq("status", from);
    fail(reportError(error));
    return count ?? 0;
  },

  async deleteReport(id) {
    const { error, count } = await sb.from("reports").delete({ count: "exact" }).eq("id", id);
    fail(reportError(error));
    if (count === 0) throw new Error("Nothing was deleted. Reload and try again.");
  },

  async reportAction(id, action) {
    const { data, error } = await sb.functions.invoke("report-action", { body: { action, report_id: id } });
    if (error) {
      let message = "Couldn't reach the report service. Try again.";
      if (error instanceof FunctionsHttpError) {
        try {
          message = String((await error.context.json()).error ?? message);
        } catch {
          // keep the generic message
        }
      }
      throw new Error(message);
    }
    return { started: (data as { started: "render" | "send" | null }).started };
  },

  async reportSettings() {
    const { data, error } = await sb.from("report_settings").select("mode, auto_send_default, generate_time, send_time, sunday_review_email, template, updated_at").eq("id", 1).single();
    fail(error);
    return data as ReportSettings;
  },

  async saveReportSettings(patch) {
    const { error, count } = await sb.from("report_settings").update(patch, { count: "exact" }).eq("id", 1);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  subscribeReports(cb) {
    // Rows can be large, so this is only a signal: the page refetches what it shows.
    const ch = sb.channel("reports").on("postgres_changes", { event: "*", schema: "public", table: "reports" }, () => cb()).subscribe();
    return () => void sb.removeChannel(ch);
  },
};

const REPORT_LIST = "id, created_at, updated_at, client_id, period, period_key, period_start, period_end, is_test, status, send_at, recipients, cc, subject, failure_count, warnings, content_version, rendered_version, rendered_at, render_error, claimed_at, attempts, sent_at, error, clients(company, contact_name)";

function normReport(r: Record<string, unknown>): ReportRow {
  const c = r.clients as { company: string | null; contact_name: string | null } | null;
  const { clients: _, ...rest } = r;
  return { ...(rest as ReportRow), client_name: c?.company || c?.contact_name || "Unknown client" };
}

/** Report rule violations as sentences (the guard trigger's own messages are already plain). */
function reportError(e: { message: string; code?: string } | null) {
  if (!e) return null;
  if (e.code === "23514") return { message: "Something isn't valid: check the recipients (1 to 10 real addresses), the subject, and the body." };
  if (e.code === "42501") return { message: "That change isn't allowed here." };
  return e;
}

// Postgres numerics arrive as strings; make them numbers once, here.
function normLead(r: Record<string, unknown>): Lead {
  return { ...(r as Lead), value_monthly: Number(r.value_monthly), value_one_time: Number(r.value_one_time) };
}
function normLine<T extends ServiceLine>(r: Record<string, unknown>): T {
  return { ...(r as T), amount: Number(r.amount), unit_amount: Number(r.unit_amount ?? r.amount), quantity: Number(r.quantity ?? 1) };
}

/** Audit entries for a row and its children (e.g. a client and its client_services), newest first. */
async function activityOf(parentKey: "client_id" | "project_id", id: string): Promise<AuditEntry[]> {
  if (!UUID.test(id)) return [];
  const { data, error } = await sb.from("audit_log").select("*")
    .or(`row_id.eq.${id},new_data->>${parentKey}.eq.${id},old_data->>${parentKey}.eq.${id}`)
    .order("at", { ascending: false }).limit(200);
  fail(error);
  const { data: hidden } = await sb.from("activity_hidden").select("audit_id");
  const hiddenIds = new Set((hidden ?? []).map((h) => Number(h.audit_id)));
  return ((data ?? []) as AuditEntry[]).map((a) => ({ ...a, hidden: hiddenIds.has(Number(a.id)) }));
}

/** Turn database rule violations into plain sentences. */
function friendly(e: { message: string; code?: string } | null) {
  if (!e) return null;
  if (e.code === "23505") return { message: "That name is already taken. Try a slightly different one." };
  if (e.code === "23503") return { message: "This category still has services. Move or delete them first." };
  if (e.code === "23514") return { message: "Something in the form isn't valid (check required fields and lengths)." };
  return e;
}

const ownerGone = (e: { message: string; code?: string } | null) =>
  e?.code === "23503" ? { message: "That lead or client was deleted. Reload and pick another." } : friendly(e);

function normQuote(r: Record<string, unknown>): Quote {
  return { ...(r as Quote), monthly_total: Number(r.monthly_total), one_time_total: Number(r.one_time_total) };
}

export default db;
