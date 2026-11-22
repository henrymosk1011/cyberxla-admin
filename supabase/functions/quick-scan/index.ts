// quick-scan: the Prospects page's "Quick scan" button. Runs a passive external
// scan of a URL the admin types in, synchronously, and returns a provisional
// grade and findings so they can decide whether to add it as a prospect. It does
// NOT add anything: adding happens separately from the dashboard.
//
// Same shape as prospect-discover / audit-action:
// 1. POST only, from admin.cyberx.la only, with a small body cap.
// 2. The admin check runs as the signed in user (their token plus the public
//    key), so row level security decides: only an allowlisted admin whose
//    session finished MFA gets past public.is_admin(). No service role key.
// 3. The scan is passive only: it reads public signals (headers, cookies, DNS
//    over HTTPS for SPF/DMARC, crt.sh subdomains, stale libraries). It never
//    probes. The scoring is the same engine the full audit uses (scan.ts), so
//    the preview grade matches, give or take the certificate depth noted below.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   PUBLISHABLE_KEY  optional; only if the function reports a missing publishable key
// Supabase provides SUPABASE_URL.

import { ALLOWED_ORIGINS, BadRequest, MAX_BODY_BYTES, parseParams, publishableKey, type ScanParams } from "./lib.ts";
import { analyze, collect } from "./scan.ts";
import { fetchNet } from "./net.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw Object.assign(new Error(`missing secret ${name}`), { missing: name });
  return v;
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
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BadRequest("size");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("json");
  }
}

/** PostgREST as the caller: their token decides whether they're an admin. */
function asUser(authorization: string) {
  const base = `${env("SUPABASE_URL")}/rest/v1`;
  const headers = { "apikey": publishableKey((k) => Deno.env.get(k)), "Authorization": authorization, "Content-Type": "application/json" };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (!res.ok) throw Object.assign(new Error(`database ${res.status}`), { status: res.status });
    return body ? JSON.parse(body) : null;
  };
  return { isAdmin: async () => (await call("rpc/is_admin", { method: "POST", body: "{}" })) === true };
}

async function runScan(params: ScanParams) {
  const obs = await collect(params.target, fetchNet);
  const notes: string[] = [];
  if (!obs.reachable) {
    return { ok: true, reachable: false, domain: obs.domain, target: obs.target, grade: null, score: null, summary: null, findings: [], checked_at: new Date().toISOString(), notes: ["Couldn't load the site over HTTPS. It may be down, blocking scanners, or its certificate may be invalid. You can still add it and run a full audit."] };
  }
  // A successful HTTPS load means the certificate is currently valid (fetch
  // rejects an expired or untrusted one). Record that; the full audit reads the
  // real issuer, protocol and days left.
  if (!obs.tls) {
    obs.tls = { ok: true, issuer: null, valid_to: null, daysLeft: null, expired: false, protocol: null };
    notes.push("Quick scan: certificate details (issuer, days left) are read by the full audit after you add it.");
  }
  const a = analyze(obs);
  return {
    ok: true, reachable: true, domain: obs.domain, target: obs.target,
    grade: a.grade, score: a.score, summary: a.summary, findings: a.findings,
    checked_at: new Date().toISOString(), notes,
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" }, headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" }, headers);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(authorization)) return reply(401, { error: "Sign in again." }, headers);

  let params: ScanParams;
  try {
    params = parseParams(await readBody(req));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "That doesn't look like a website address. Try something like example.com." }, headers);
    throw e;
  }

  const db = asUser(authorization);
  try {
    if (!(await db.isAdmin())) return reply(403, { error: "Only an admin who finished MFA can do this." }, headers);
    const result = await runScan(params);
    return reply(200, result, headers);
  } catch (e) {
    const err = e as Error & { status?: number; missing?: string };
    console.error("quick-scan", params.domain, err.message);
    if (err.missing) return reply(503, { error: `Quick scan isn't fully set up yet (the ${err.missing} secret).` }, headers);
    if (err.status === 401) return reply(401, { error: "Sign in again." }, headers);
    return reply(502, { error: "The quick scan couldn't finish. Try again in a moment." }, headers);
  }
});
