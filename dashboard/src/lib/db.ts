// Supabase implementation of Db. Every query runs as the signed-in user, so the
// database's row-level security decides what comes back: nothing at all unless
// the user is on the admin allowlist AND finished MFA this session.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { priceQuote } from "./catalog.ts";
import { catalog } from "./store.svelte.ts";
import type { AuditEntry, AuthState, ChangeEvent, Client, ClientService, Db, Enrollment, Lead, LeadStatus, Note, Quote, QuoteStatus, ServiceRow } from "./types.ts";

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
    return (data ?? []).map(normClientService);
  },

  async clientServices(clientId) {
    const { data, error } = await sb.from("client_services").select("*").eq("client_id", clientId).order("sort").order("created_at");
    fail(error);
    return (data ?? []).map(normClientService);
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

  async clientActivity(clientId) {
    if (!UUID.test(clientId)) return [];
    const { data, error } = await sb.from("audit_log").select("*")
      .or(`row_id.eq.${clientId},new_data->>client_id.eq.${clientId},old_data->>client_id.eq.${clientId}`)
      .order("at", { ascending: false }).limit(200);
    fail(error);
    const { data: hidden } = await sb.from("activity_hidden").select("audit_id");
    const hiddenIds = new Set((hidden ?? []).map((h) => Number(h.audit_id)));
    return ((data ?? []) as AuditEntry[]).map((a) => ({ ...a, hidden: hiddenIds.has(Number(a.id)) }));
  },

  async convertLead(leadId) {
    const { data, error } = await sb.rpc("convert_lead_to_client", { p_lead: leadId });
    fail(error);
    return data as string;
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
};

// Postgres numerics arrive as strings; make them numbers once, here.
function normLead(r: Record<string, unknown>): Lead {
  return { ...(r as Lead), value_monthly: Number(r.value_monthly), value_one_time: Number(r.value_one_time) };
}
function normClientService(r: Record<string, unknown>): ClientService {
  return { ...(r as ClientService), amount: Number(r.amount) };
}

/** Turn database rule violations into plain sentences. */
function friendly(e: { message: string; code?: string } | null) {
  if (!e) return null;
  if (e.code === "23505") return { message: "That name is already taken. Try a slightly different one." };
  if (e.code === "23503") return { message: "This category still has services. Move or delete them first." };
  if (e.code === "23514") return { message: "Something in the form isn't valid (check required fields and lengths)." };
  return e;
}

function normQuote(r: Record<string, unknown>): Quote {
  return { ...(r as Quote), monthly_total: Number(r.monthly_total), one_time_total: Number(r.one_time_total) };
}

export default db;
