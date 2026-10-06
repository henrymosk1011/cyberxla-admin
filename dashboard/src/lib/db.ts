// Supabase implementation of Db. Every query runs as the signed-in user, so the
// database's row-level security decides what comes back: nothing at all unless
// the user is on the admin allowlist AND finished MFA this session.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuditEntry, AuthState, ChangeEvent, Db, Enrollment, Lead, LeadStatus, Note, Quote, QuoteStatus } from "./types.ts";

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
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app", issuer: "cyberXLA Admin" });
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
    return (data ?? []) as AuditEntry[];
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
function normQuote(r: Record<string, unknown>): Quote {
  return { ...(r as Quote), monthly_total: Number(r.monthly_total), one_time_total: Number(r.one_time_total) };
}

export default db;
