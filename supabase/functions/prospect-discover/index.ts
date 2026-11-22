// prospect-discover: the Prospects page's "Find businesses" button.
//
// Same shape as audit-action / report-action:
// 1. POST only, from admin.cyberx.la only, with a small body cap.
// 2. The admin check runs as the signed-in user (their token plus the public
//    key), so row level security decides: only an allowlisted admin whose
//    session finished MFA gets past public.is_admin(). No service role key.
// 3. We search a business directory for `term` in `location` and add what we
//    find by calling public.add_prospects() over the same connection (an
//    admin-gated wrapper over prospecting.add_prospects(), which de-dupes on
//    (source, source_ref)). We return { found, added }.
//
// Discovery reuses the Apify source and the APIFY_TOKEN secret the lead-finder
// function already uses (Apify's Google Maps Scraper), rather than adding a new
// directory key. See lib.ts for why both source options discover through it.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   APIFY_TOKEN      the Apify token lead-finder already uses
//   PUBLISHABLE_KEY  optional; only if the function reports a missing publishable key
// Supabase provides SUPABASE_URL.

import { ACTOR, ALLOWED_ORIGINS, apifyInput, BadRequest, type DiscoverParams, MAX_BODY_BYTES, parseParams, PLACE_FIELDS, type Prospect, publishableKey, toProspects } from "./lib.ts";

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

/** An error from the Apify directory search, shown to the caller as a 502. */
class DiscoveryError extends Error {}

/**
 * Run the Google Maps Scraper synchronously and return its places. run-sync
 * holds the connection until the run finishes (Apify caps it at 300s); for the
 * small result counts this button asks for it returns in well under that.
 */
async function discover(params: DiscoverParams): Promise<unknown[]> {
  const token = env("APIFY_TOKEN");
  const q = new URLSearchParams({ format: "json", clean: "true", limit: String(params.limit), fields: PLACE_FIELDS.join(","), timeout: "120" });
  let res: Response;
  try {
    res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?${q}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(apifyInput(params)),
      signal: AbortSignal.timeout(140_000),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new DiscoveryError("the search took too long. Try again, or ask for fewer businesses.");
    throw new DiscoveryError("couldn't reach the business directory.");
  }
  if (!res.ok) {
    const detail = res.status === 401 ? "Apify didn't accept the token (APIFY_TOKEN)"
      : res.status === 402 ? "the Apify account is out of credit"
      : res.status === 408 ? "the search took too long"
      : res.status === 429 ? "too many searches at once, wait a minute"
      : `the directory answered ${res.status}`;
    await res.body?.cancel();
    throw new DiscoveryError(detail);
  }
  const items = await res.json().catch(() => null);
  if (!Array.isArray(items)) throw new DiscoveryError("the directory sent an unexpected response.");
  return items;
}

/** PostgREST as the caller: their token decides what they can see and change. */
function asUser(authorization: string) {
  const base = `${env("SUPABASE_URL")}/rest/v1`;
  const headers = { "apikey": publishableKey((k) => Deno.env.get(k)), "Authorization": authorization, "Content-Type": "application/json" };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (!res.ok) {
      let message = "";
      try {
        message = String(JSON.parse(body).message ?? "");
      } catch {
        // not JSON
      }
      throw Object.assign(new Error(`database ${res.status}: ${body.slice(0, 300)}`), { status: res.status, dbMessage: message });
    }
    return body ? JSON.parse(body) : null;
  };
  return {
    isAdmin: async () => (await call("rpc/is_admin", { method: "POST", body: "{}" })) === true,
    // Returns how many prospects were newly added (deduped on source, source_ref).
    addProspects: async (prospects: Prospect[]): Promise<number> => {
      const out = await call("rpc/add_prospects", { method: "POST", body: JSON.stringify({ p: prospects }) });
      const n = Array.isArray(out) ? out[0] : out;
      return Number(n) || 0;
    },
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

  let params: DiscoverParams;
  try {
    params = parseParams(await readBody(req));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  const db = asUser(authorization);
  try {
    if (!(await db.isAdmin())) return reply(403, { error: "Only an admin who finished MFA can do this." }, headers);

    const prospects = toProspects(await discover(params));
    const found = prospects.length;
    const added = found ? await db.addProspects(prospects) : 0;
    return reply(200, { found, added }, headers);
  } catch (e) {
    const err = e as Error & { status?: number; dbMessage?: string; missing?: string };
    console.error("prospect-discover", params.source, err.message);
    if (err.missing) return reply(503, { error: `Business discovery isn't set up yet (the ${err.missing} secret).` }, headers);
    if (err instanceof DiscoveryError) return reply(502, { error: `Couldn't run discovery: ${err.message}` }, headers);
    if (err.status === 401) return reply(401, { error: "Sign in again." }, headers);
    if (err.status === 400 || err.status === 403) return reply(403, { error: err.dbMessage || "The database refused that." }, headers);
    return reply(503, { error: "Try again." }, headers);
  }
});
