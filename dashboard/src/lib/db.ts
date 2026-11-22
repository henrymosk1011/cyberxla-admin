// Supabase implementation of Db. Every query runs as the signed-in user, so the
// database's row-level security decides what comes back: nothing at all unless
// the user is on the admin allowlist AND finished MFA this session.
import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";
import { priceQuote } from "./catalog.ts";
import { catalog } from "./store.svelte.ts";
import type { Audit, AuditAuthorization, AuditEntry, AuditRow, AuditSettings, AuthorizationInput, AuthState, ChangeEvent, Client, ClientService, Credential, Db, Enrollment, Lead, LeadStatus, Note, PackageRow, Payment, Project, Proposal, ProposalAcceptance, ProposalEvent, ProposalRow, ProposalTemplate, ProposalVersion, ProjectService, Prospect, ProspectInput, ProspectNote, Quote, QuoteSettings, QuoteStatus, Report, ReportFile, ReportRow, ReportSettings, ServiceLine, ServiceRow, UnifiStatus, VaultConfig } from "./types.ts";

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

  async clearReports(ids, cleared) {
    if (!ids.length) return 0;
    const { error, count } = await sb.from("reports").update({ cleared_at: cleared ? new Date().toISOString() : null }, { count: "exact" }).in("id", ids);
    fail(reportError(error));
    return count ?? 0;
  },

  async deleteReport(id) {
    const { error, count } = await sb.from("reports").delete({ count: "exact" }).eq("id", id);
    fail(reportError(error));
    if (count === 0) throw new Error("Nothing was deleted. Reload and try again.");
  },

  async deleteReports(ids) {
    if (!ids.length) return 0;
    const { error, count } = await sb.from("reports").delete({ count: "exact" }).in("id", ids);
    fail(reportError(error));
    return count ?? 0;
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
    return { started: (data as { started: "render" | "send" | "unifi" | "copy" | null }).started };
  },

  async unifiStatus(clientId) {
    if (!UUID.test(clientId)) return null;
    const { data, error } = await sb.from("unifi_status").select("client_id, console, checked_at, data").eq("client_id", clientId).maybeSingle();
    fail(error);
    return (data as UnifiStatus) ?? null;
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

  async createLead(l) {
    const { data, error } = await sb.from("leads").insert({ ...l, email: l.email.trim().toLowerCase(), source: "manual" }).select("id").single();
    if (error?.code === "23505") throw new Error("A lead with that email already exists. Pick it from the list instead.");
    fail(friendly(error));
    return (data as { id: string }).id;
  },

  async proposals() {
    const { data, error } = await sb.from("proposals").select(PROPOSAL_LIST).order("number", { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []).map(normProposal) as ProposalRow[];
  },

  async proposal(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("proposals").select(`${PROPOSAL_LIST}, internal, internal_notes`).eq("id", id).maybeSingle();
    fail(error);
    return data ? (normProposal(data) as Proposal) : null;
  },

  async createProposal(p) {
    const { data, error } = await sb.from("proposals").insert(p).select("id").single();
    fail(proposalError(error));
    return (data as { id: string }).id;
  },

  async updateProposal(id, patch) {
    const { error, count } = await sb.from("proposals").update(patch, { count: "exact" }).eq("id", id);
    fail(proposalError(error));
    if (count === 0) throw new Error("Nothing was saved. Reload and try again.");
  },

  async deleteProposal(id) {
    const { error, count } = await sb.from("proposals").delete({ count: "exact" }).eq("id", id);
    fail(proposalError(error));
    if (count === 0) throw new Error("Nothing was deleted. Reload and try again.");
  },

  async proposalEvents(id) {
    const { data, error } = await sb.from("proposal_events").select("*").eq("proposal_id", id).order("at", { ascending: false }).order("id", { ascending: false }).limit(300);
    fail(error);
    return (data ?? []) as ProposalEvent[];
  },

  async recentProposalEvents(limit) {
    const { data, error } = await sb.from("proposal_events").select("*").not("kind", "in", "(edited)").order("at", { ascending: false }).limit(limit);
    fail(error);
    return (data ?? []) as ProposalEvent[];
  },

  async proposalVersions(id) {
    const { data, error } = await sb.from("proposal_versions").select("id, proposal_id, version, sent_at, header, content").eq("proposal_id", id).order("version", { ascending: false });
    fail(error);
    return (data ?? []) as ProposalVersion[];
  },

  async proposalAcceptances(id) {
    const { data, error } = await sb.from("proposal_acceptances")
      .select("id, proposal_id, version, accepted_at, tier, addons, lines, once_total, monthly_total, due_now, signer_name, signer_title, signer_email, signature, doc")
      .eq("proposal_id", id).order("accepted_at", { ascending: false });
    fail(error);
    return (data ?? []).map((a) => ({ ...(a as ProposalAcceptance), once_total: Number(a.once_total), monthly_total: Number(a.monthly_total), due_now: Number(a.due_now) }));
  },

  async proposalRpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    fail(proposalError(error));
    return data;
  },

  async quoteAction(body) {
    const { data, error } = await sb.functions.invoke("quote-action", { body });
    if (error) {
      let message = "Couldn't reach the quote service. Try again.";
      if (error instanceof FunctionsHttpError) {
        try {
          message = String((await error.context.json()).error ?? message);
        } catch {
          // keep the generic message
        }
      }
      throw new Error(message);
    }
    return data as Record<string, unknown>;
  },

  async templates() {
    const { data, error } = await sb.from("proposal_templates").select("*").order("name");
    fail(error);
    return (data ?? []) as ProposalTemplate[];
  },

  async saveTemplate(t, id) {
    const { data, error } = id
      ? await sb.from("proposal_templates").update(t).eq("id", id).select("id").single()
      : await sb.from("proposal_templates").insert(t).select("id").single();
    if (error?.code === "23505") throw new Error("A template with that name already exists. Pick another name.");
    fail(proposalError(error));
    return (data as { id: string }).id;
  },

  async deleteTemplate(id) {
    const { error } = await sb.from("proposal_templates").delete().eq("id", id);
    fail(error);
  },

  async quoteSettings() {
    const { data, error } = await sb.from("quote_settings").select("notify_email, reply_to, from_name, default_valid_days, remind_unviewed_days, remind_expiry_days, stripe_mode, stripe_checked_at, cron_seen_at, updated_at").eq("id", 1).single();
    fail(error);
    return data as QuoteSettings;
  },

  async saveQuoteSettings(patch) {
    const { error, count } = await sb.from("quote_settings").update(patch, { count: "exact" }).eq("id", 1);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async payments() {
    const { data, error } = await sb.from("payments").select("id, created_at, proposal_id, acceptance_id, project_id, kind, amount, status, livemode, stripe_session_id, stripe_payment_intent, paid_at").order("created_at", { ascending: false }).limit(2000);
    fail(error);
    return (data ?? []).map((p) => ({ ...(p as Payment), amount: Number(p.amount) }));
  },

  subscribeProposals(cb) {
    const ch = sb.channel("proposals")
      .on("postgres_changes", { event: "*", schema: "public", table: "proposals" }, () => cb())
      .on("postgres_changes", { event: "*", schema: "public", table: "proposal_events" }, () => cb())
      .subscribe();
    return () => void sb.removeChannel(ch);
  },

  // -- Prospecting: outbound security audits ---------------------------------
  async prospects() {
    const { data, error } = await sb.from("prospects").select("*").order("updated_at", { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []) as Prospect[];
  },

  async prospect(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("prospects").select("*").eq("id", id).maybeSingle();
    fail(error);
    return (data as Prospect) ?? null;
  },

  async createProspect(p) {
    const { data, error } = await sb.from("prospects").insert(cleanProspect(p)).select("id").single();
    if (error?.code === "23505") throw new Error("A prospect from that source is already on the list.");
    fail(friendly(error));
    return (data as { id: string }).id;
  },

  async updateProspect(id, patch) {
    const { error } = await sb.from("prospects").update(cleanProspect(patch)).eq("id", id);
    fail(friendly(error));
  },

  async deleteProspect(id) {
    const { error, count } = await sb.from("prospects").delete({ count: "exact" }).eq("id", id);
    if (error?.code === "23503") throw new Error("This prospect has a sent audit, which is kept for the record. Archive it instead.");
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async archiveProspect(id, archived) {
    const { error } = await sb.from("prospects").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
    fail(error);
  },

  async importProspects(rows) {
    if (!rows.length) return 0;
    const { data, error } = await sb.from("prospects").insert(rows.map(cleanProspect)).select("id");
    fail(friendly(error));
    return (data ?? []).length;
  },

  async prospectNotes(id) {
    const { data, error } = await sb.from("prospect_notes").select("id, prospect_id, created_at, body").eq("prospect_id", id).order("created_at", { ascending: false });
    fail(error);
    return (data ?? []) as ProspectNote[];
  },

  async addProspectNote(prospectId, body) {
    const { error } = await sb.from("prospect_notes").insert({ prospect_id: prospectId, body });
    fail(error);
  },

  async deleteProspectNote(id) {
    const { error, count } = await sb.from("prospect_notes").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async prospectActivity(id) {
    if (!UUID.test(id)) return [];
    const { data, error } = await sb.from("audit_log").select("*")
      .or(`row_id.eq.${id},new_data->>prospect_id.eq.${id},old_data->>prospect_id.eq.${id}`)
      .order("at", { ascending: false }).limit(200);
    fail(error);
    return (data ?? []) as AuditEntry[];
  },

  async convertProspect(id) {
    const p = await db.prospect(id);
    if (!p) throw new Error("That prospect was deleted. Reload and try again.");
    if (!p.email) throw new Error("Add a contact email to the prospect before converting it to a lead.");
    const leadId = await db.createLead({ name: p.contact_name || p.business_name, company: p.business_name, email: p.email, phone: p.phone });
    const { error } = await sb.from("prospects").update({ lead_id: leadId, status: "converted" }).eq("id", id);
    fail(error);
    return leadId;
  },

  async audits() {
    const { data, error } = await sb.from("audits").select(AUDIT_LIST).order("created_at", { ascending: false }).limit(1000);
    fail(error);
    return (data ?? []).map(normAudit);
  },

  async auditsFor(prospectId) {
    const { data, error } = await sb.from("audits").select(AUDIT_LIST).eq("prospect_id", prospectId).order("created_at", { ascending: false });
    fail(error);
    return (data ?? []).map(normAudit);
  },

  async audit(id) {
    if (!UUID.test(id)) return null;
    const { data, error } = await sb.from("audits").select(`${AUDIT_LIST}, findings, meta, email_body`).eq("id", id).maybeSingle();
    fail(error);
    return data ? (normAudit(data) as Audit) : null;
  },

  async auditPages(id) {
    const { data, error } = await sb.rpc("audit_pages", { p_audit: id });
    fail(error);
    return ((data ?? []) as { page: number; version: number; png: string }[]).map((p) => ({ page: p.page, version: p.version, src: `data:image/png;base64,${p.png}` }));
  },

  async auditPdf(id, kind) {
    const { data, error } = await sb.rpc("audit_file", { p_audit: id, p_kind: kind });
    fail(error);
    return (data as string | null) ?? null;
  },

  async auditActivity(id) {
    if (!UUID.test(id)) return [];
    const { data, error } = await sb.from("audit_log").select("*").eq("table_name", "audits").eq("row_id", id).order("at", { ascending: false }).limit(100);
    fail(error);
    return (data ?? []) as AuditEntry[];
  },

  async updateAudit(id, patch) {
    const { error, count } = await sb.from("audits").update(patch, { count: "exact" }).eq("id", id);
    fail(auditError(error));
    if (count === 0) throw new Error("Nothing was saved. Reload the audit and try again.");
  },

  async deleteAudit(id) {
    const { error, count } = await sb.from("audits").delete({ count: "exact" }).eq("id", id);
    fail(auditError(error));
    if (count === 0) throw new Error("Nothing was deleted. Reload and try again.");
  },

  async startAudit(prospectId, kind, isTest) {
    const { data, error } = await sb.from("audits").insert({ prospect_id: prospectId, kind, is_test: isTest, scan_status: "queued" }).select("id").single();
    fail(auditError(error));
    return (data as { id: string }).id;
  },

  async auditAction(id, action) {
    const { data, error } = await sb.functions.invoke("audit-action", { body: { action, audit_id: id } });
    if (error) {
      let message = "Couldn't reach the audit service. Try again.";
      if (error instanceof FunctionsHttpError) {
        try {
          message = String((await error.context.json()).error ?? message);
        } catch {
          // keep the generic message
        }
      }
      throw new Error(message);
    }
    return { started: (data as { started: "scan" | "render" | "send" | "copy" | null }).started };
  },

  async authorizations(prospectId) {
    const { data, error } = await sb.from("audit_authorizations").select("*").eq("prospect_id", prospectId).order("created_at", { ascending: false });
    fail(error);
    return (data ?? []) as AuditAuthorization[];
  },

  async addAuthorization(a) {
    const { error } = await sb.from("audit_authorizations").insert(a as AuthorizationInput);
    fail(friendly(error));
  },

  async setAuthorizationRevoked(id, revoked) {
    const { error } = await sb.from("audit_authorizations").update({ revoked_at: revoked ? new Date().toISOString() : null }).eq("id", id);
    fail(error);
  },

  async deleteAuthorization(id) {
    const { error, count } = await sb.from("audit_authorizations").delete({ count: "exact" }).eq("id", id);
    fail(error);
    if (count === 0) throw new Error("Nothing was deleted. Try signing in again.");
  },

  async auditSettings() {
    const { data, error } = await sb.from("audit_settings").select("mode, passive_enabled, active_enabled, sender_email, sender_name, reply_to, default_subject, default_body, updated_at").eq("id", 1).single();
    fail(error);
    return data as AuditSettings;
  },

  async saveAuditSettings(patch) {
    const { error, count } = await sb.from("audit_settings").update(patch, { count: "exact" }).eq("id", 1);
    fail(friendly(error));
    if (count === 0) throw new Error("Nothing was saved. Try signing in again.");
  },

  async discoverProspects(params) {
    const { data, error } = await sb.functions.invoke("prospect-discover", { body: params });
    if (error) {
      let message = "Couldn't run discovery. Try again.";
      if (error instanceof FunctionsHttpError) {
        try {
          message = String((await error.context.json()).error ?? message);
        } catch {
          // keep the generic message
        }
      }
      throw new Error(message);
    }
    return data as { found: number; added: number };
  },

  subscribeProspecting(cb) {
    const ch = sb.channel("prospecting")
      .on("postgres_changes", { event: "*", schema: "public", table: "prospects" }, () => cb())
      .on("postgres_changes", { event: "*", schema: "public", table: "audits" }, () => cb())
      .subscribe();
    return () => void sb.removeChannel(ch);
  },
};

const PROPOSAL_LIST = "id, number, created_at, updated_at, lead_id, client_id, title, status, recipient_name, recipient_email, cc, prepared_on, valid_until, content, token, version, revising, link_only, scheduled_at, send_subject, send_note, reminders, sent_at, last_sent_at, first_viewed_at, last_viewed_at, view_count, changes_requested_at, accepted_at, accepted_version, accepted_once, accepted_monthly, archived_at";

function normProposal(r: Record<string, unknown>) {
  return { ...r, accepted_once: r.accepted_once === null ? null : Number(r.accepted_once), accepted_monthly: r.accepted_monthly === null ? null : Number(r.accepted_monthly) };
}

/** The database's own messages for quotes are already plain sentences. */
function proposalError(e: { message: string; code?: string } | null) {
  if (!e) return null;
  if (e.code === "23514") return { message: "Something in the quote isn't valid. Check the prices, the required names, and the lengths." };
  if (e.code === "42501") return { message: "That change isn't allowed here. Sign in again if this keeps happening." };
  return e;
}

const REPORT_LIST = "id, created_at, updated_at, client_id, period, period_key, period_start, period_end, is_test, status, send_at, recipients, cc, subject, failure_count, warnings, content_version, rendered_version, rendered_at, render_error, claimed_at, attempts, sent_at, error, cleared_at, clients(company, contact_name)";

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
  // The database's guard says "cleared" (its name when it was added); the dashboard calls it Archive.
  if (e.code === "P0403") return { ...e, message: e.message.replace("Clear it first, then delete it from Cleared.", "Archive it first, then delete it from Archived.").replace("can be cleared", "can be archived") };
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

const AUDIT_LIST = "id, created_at, updated_at, prospect_id, kind, is_test, scan_status, target_url, target_domain, grade, score, summary, scanner_version, started_at, finished_at, scan_error, attempts, authorization_id, content_version, rendered_version, rendered_at, render_error, delivery, recipients, subject, sent_at, send_error";

function normAudit(r: Record<string, unknown>): AuditRow {
  return { ...(r as AuditRow), score: r.score === null || r.score === undefined ? null : Number(r.score) };
}

/** Normalize a prospect before it is saved: trim and lower-case the domain and
 *  email, make sure the website has a scheme, and derive the domain from the
 *  website when it is missing. */
function cleanProspect<T extends Record<string, unknown>>(p: T): T {
  const out: Record<string, unknown> = { ...p };
  if (typeof out.email === "string") out.email = out.email.trim().toLowerCase() || null;
  if (typeof out.website === "string") {
    const w = out.website.trim();
    out.website = w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : null;
  }
  if (typeof out.domain === "string") out.domain = out.domain.trim().toLowerCase() || null;
  if ((out.domain === undefined || out.domain === null) && typeof out.website === "string") {
    try {
      out.domain = new URL(out.website).hostname.replace(/^www\./, "").toLowerCase() || null;
    } catch {
      // leave the domain unset if the website isn't a valid URL
    }
  }
  return out as T;
}

/** Audit rule violations as plain sentences (the guard's own messages already are). */
function auditError(e: { message: string; code?: string } | null) {
  if (!e) return null;
  if (e.code === "23514") return { message: "Something isn't valid: check the recipients (up to 10 real addresses) and the lengths." };
  if (e.code === "23503") return { message: "That prospect was deleted. Reload and try again." };
  if (e.code === "42501") return { message: "That change isn't allowed here. Sign in again if this keeps happening." };
  return e; // P0403 (the guard, incl. the authorization gate) is already a plain sentence
}

export default db;
