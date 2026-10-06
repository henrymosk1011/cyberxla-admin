// submit-quote: the only public entry point for new quotes.
//
// 1. Accepts POST only, from cyberx.la only, with a small body cap.
// 2. Verifies the Cloudflare Turnstile token server-side.
// 3. Validates every field and re-prices the quote from the live service
//    catalog in the database (public.service_catalog()).
//    Prices sent by the browser are ignored.
// 4. Stores it by calling intake.submit_quote() as the quote_intake role,
//    which can do nothing else. No service-role key is used.
// 5. Sends a plain-text alert email through Resend, if configured.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   TURNSTILE_SECRET_KEY, INTAKE_DB_URL, IP_HASH_SALT
//   RESEND_API_KEY, ALERT_EMAIL (optional: email alerts)

import postgres from "npm:postgres@3.4.5";
import { BadRequest, catalogFromRpc, parseSubmission, type Catalog, type priceQuote } from "./lib.ts";

const ALLOWED_ORIGINS = new Set(["https://cyberx.la", "https://www.cyberx.la"]);
const TURNSTILE_HOSTNAMES = new Set(["cyberx.la", "www.cyberx.la"]);
const MAX_BODY_BYTES = 16 * 1024;
// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

let sql: ReturnType<typeof postgres> | null = null;
function db() {
  // Transaction-mode pooler: no prepared statements.
  sql ??= postgres(env("INTAKE_DB_URL"), { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5, ssl: "require" });
  return sql;
}

// The catalog changes rarely; cache it briefly per function instance.
let catalogCache: { at: number; catalog: Catalog } | null = null;
async function getCatalog(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.catalog;
  const rows = await db()`select public.service_catalog() as c`;
  const catalog = catalogFromRpc(rows[0]?.c);
  if (!Object.keys(catalog).length) throw new Error("empty catalog");
  catalogCache = { at: Date.now(), catalog };
  return catalog;
}

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("size");
  const reader = req.body?.getReader();
  if (!reader) throw new BadRequest("body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new BadRequest("size"); }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new BadRequest("json");
  }
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const form = new FormData();
  form.append("secret", env("TURNSTILE_SECRET_KEY"));
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  form.append("idempotency_key", crypto.randomUUID());
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return false;
  const out = await res.json();
  return out.success === true && TURNSTILE_HOSTNAMES.has(out.hostname) && out.action === "quote";
}

async function hashIp(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("IP_HASH_SALT")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip || "unknown"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

async function sendAlert(lead: ReturnType<typeof parseSubmission>["lead"], priced: ReturnType<typeof priceQuote>) {
  // Email alerts are optional: without a Resend key, quotes still land in the dashboard.
  if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("ALERT_EMAIL")) return;
  // Plain text only, so nothing a visitor types can render as HTML.
  const lines = [
    "New quote from the website.",
    "",
    `Name: ${lead.name}`,
    `Company: ${lead.company || "-"}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || "-"}`,
    `Workstations: ${lead.workstations}   Servers: ${lead.servers}`,
    "",
    ...priced.items.map((i) => `- ${i.name}: ${i.from ? "from " : ""}${money(i.cost)} ${i.kind === "monthly" ? "per month" : "one time"}`),
    "",
    `Monthly: ${money(priced.monthly_total)}${priced.monthly_minimum_applied ? " (monthly minimum)" : ""}`,
    `One time: ${money(priced.one_time_total)}`,
    "",
    lead.message ? `Message:\n${lead.message}` : "",
  ];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "cyberxLA Quotes <quotes@notify.cyberx.la>",
      to: [env("ALERT_EMAIL")],
      // Fixed subject: no visitor-controlled text in headers.
      subject: `New quote: ${money(priced.monthly_total)}/mo + ${money(priced.one_time_total)} one time`,
      text: lines.join("\n"),
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) console.error("alert email failed", res.status);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" }, headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" }, headers);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "unsupported media type" }, headers);
  }

  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();

  let catalog: Catalog;
  try {
    catalog = await getCatalog();
  } catch (e) {
    console.error("catalog error", e instanceof Error ? e.message : "unknown");
    return reply(503, { error: "try again" }, headers);
  }

  let parsed;
  try {
    parsed = parseSubmission(await readBody(req), catalog);
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  try {
    if (!(await verifyTurnstile(parsed.token, ip))) return reply(403, { error: "verification failed" }, headers);
  } catch (e) {
    console.error("turnstile error", e instanceof Error ? e.message : "unknown");
    return reply(503, { error: "try again" }, headers);
  }

  const { lead, priced } = parsed;
  const payload = {
    name: lead.name, company: lead.company, email: lead.email, phone: lead.phone, message: lead.message,
    workstations: lead.workstations, servers: lead.servers, ...priced,
  };

  let quoteId: string;
  try {
    const ipHash = await hashIp(ip);
    const rows = await db()`select intake.submit_quote(${db().json(payload)}, ${ipHash}) as id`;
    quoteId = rows[0].id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0429") return reply(429, { error: "too many requests" }, headers);
    // Log the error code only: never the payload (it contains personal data).
    console.error("db error", code ?? "unknown");
    return reply(503, { error: "try again" }, headers);
  }

  try {
    await sendAlert(lead, priced);
  } catch (e) {
    console.error("alert email error", e instanceof Error ? e.name : "unknown");
  }

  return reply(201, { ok: true, id: quoteId }, headers);
});
