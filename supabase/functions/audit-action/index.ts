// audit-action: the dashboard's Run audit, Re-scan, Rebuild PDF, Send now,
// Send me a copy and Cancel buttons for prospect security audits.
//
// Same shape as report-action:
// 1. POST only, from admin.cyberx.la only, with a small body cap.
// 2. Every database call runs as the signed-in user (their token plus the
//    public key), so row level security decides: only an allowlisted admin
//    whose session finished MFA gets anywhere. No service role key.
// 3. The heavy work runs in GitHub Actions in the private audit repo, which
//    logs in as audit_runner (it can only call the prospecting.* functions and
//    always takes recipients and mode from the database, never from here).
//    scan/rescan start scan.yml, rebuild starts render.yml, send_now and copy
//    start send.yml (copy emails Henry only). cancel is a database change only.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   GH_ACTIONS_TOKEN  fine grained token: the audit repo only, Actions read and write
//   AUDIT_REPO        owner/name of the audit repo (e.g. henrymosk1011/cyberxla-security-audits)
//   PUBLISHABLE_KEY   optional; only if the function reports a missing publishable key
// Supabase provides SUPABASE_URL.

import { ALLOWED_ORIGINS, type AuditState, BadRequest, MAX_BODY_BYTES, dispatchRequest, parseAction, publishableKey } from "./lib.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
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
    audit: async (id: string): Promise<AuditState | null> =>
      (await call(`audits?id=eq.${id}&select=id,scan_status,delivery`))?.[0] ?? null,
    // Only move when the status is still what we saw, so a race loses cleanly.
    setScan: async (id: string, from: string, to: string): Promise<boolean> =>
      ((await call(`audits?id=eq.${id}&scan_status=eq.${from}`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({ scan_status: to }),
      })) ?? []).length === 1,
  };
}

// The scanner is hosted in the patch-reports repo; override with AUDIT_REPO.
const DEFAULT_REPO = "henrymosk1011/cyberxla-patch-reports";

async function dispatch(workflow: "audit-scan.yml" | "audit-send.yml" | "audit-render.yml", id: string | null, force = false, copy = false) {
  const { url, init } = dispatchRequest(Deno.env.get("AUDIT_REPO") ?? DEFAULT_REPO, workflow, id, env("GH_ACTIONS_TOKEN"), force, copy);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (res.status !== 204) {
    const detail = res.status === 401 ? "the GitHub token has expired or was revoked" : res.status === 404 ? "the audit repo or its workflows aren't set up yet" : `GitHub answered ${res.status}`;
    throw Object.assign(new Error(detail), { github: true });
  }
}


Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" }, headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "method not allowed" }, headers);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(authorization)) return reply(401, { error: "Sign in again." }, headers);

  let action, auditId;
  try {
    ({ action, auditId } = parseAction(await readBody(req)));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  const db = asUser(authorization);
  try {
    if (!(await db.isAdmin())) return reply(403, { error: "Only an admin who finished MFA can do this." }, headers);

    // Drain: scan every queued audit in one run. The dashboard has just filled
    // the queue with scan_prospects(); there is no single audit to look up.
    if (action === "scan_pending") {
      await dispatch("audit-scan.yml", null);
      return reply(200, { ok: true, started: "scan" }, headers);
    }

    const a = await db.audit(auditId);
    if (!a) return reply(404, { error: "Audit not found." }, headers);

    if (action === "cancel") {
      if (a.scan_status !== "queued" && a.scan_status !== "running") return reply(409, { error: "This scan can't be cancelled." }, headers);
      if (!(await db.setScan(auditId, a.scan_status, "cancelled"))) return reply(409, { error: "The audit changed a moment ago. Reload and try again." }, headers);
      return reply(200, { ok: true, started: null }, headers);
    }

    if (action === "send_now" || action === "copy") {
      if (a.scan_status !== "done") return reply(409, { error: "Run the scan first: there's nothing to send yet." }, headers);
      if (action === "send_now" && a.delivery !== "none" && a.delivery !== "failed") return reply(409, { error: `This report is already ${a.delivery}.` }, headers);
      await dispatch("audit-send.yml", auditId, false, action === "copy");
      return reply(200, { ok: true, started: "send" }, headers);
    }

    if (action === "rebuild") {
      await dispatch("audit-render.yml", auditId, true);
      return reply(200, { ok: true, started: "render" }, headers);
    }

    // scan / rescan
    if (action === "rescan") {
      if (a.scan_status === "running") return reply(409, { error: "A scan is already running." }, headers);
      if (a.scan_status !== "queued" && !(await db.setScan(auditId, a.scan_status, "queued"))) {
        return reply(409, { error: "The audit changed a moment ago. Reload and try again." }, headers);
      }
    } else if (a.scan_status !== "queued") {
      return reply(409, { error: "This audit has already run. Use Re-scan to run it again." }, headers);
    }
    await dispatch("audit-scan.yml", auditId);
    return reply(200, { ok: true, started: "scan" }, headers);
  } catch (e) {
    const err = e as Error & { status?: number; github?: boolean; dbMessage?: string };
    console.error("audit-action", action, auditId, err.message);
    if (err.github) {
      const what = action === "send_now" ? "The send didn't start" : action === "copy" ? "The copy didn't start" : action === "rebuild" ? "The rebuild didn't start" : "The scan didn't start";
      return reply(502, { error: `${what}: ${err.message}. Try again in a minute.` }, headers);
    }
    if (err.status === 401) return reply(401, { error: "Sign in again." }, headers);
    if (err.status === 400 || err.status === 403) return reply(409, { error: err.dbMessage || "The database refused that change." }, headers);
    return reply(503, { error: "Try again." }, headers);
  }
});
