// report-action: the dashboard's Send now, re-render and Rebuild buttons for patch reports.
//
// 1. POST only, from admin.cyberx.la only, with a small body cap.
// 2. Every database call runs as the signed-in user (their token plus the
//    public key), so row level security decides: only an allowlisted admin
//    whose session finished MFA gets anywhere. No service role key.
// 3. Refuses reports that are sending or already sent.
// 4. Send now marks the report scheduled for right now (the database's guard
//    checks the move) and starts the Send reports workflow for it, which
//    claims it in one step, so it can't go out twice. Render starts the Render
//    report workflow when the PDFs are behind the latest edits; Rebuild starts
//    it with force, so it renders even when they're up to date.
// 5. GitHub is called with a fine grained token that can only run Actions on
//    the reports repo, and it expires.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   GH_ACTIONS_TOKEN  fine grained token: the reports repo only, Actions read and write
//   REPORTS_REPO      owner/name of the reports repo
//   PUBLISHABLE_KEY   optional; only if the function reports a missing publishable key
// Supabase provides SUPABASE_URL.

import { ALLOWED_ORIGINS, BadRequest, MAX_BODY_BYTES, dispatchRequest, parseAction, publishableKey, refusal, renderIsCurrent, type ReportState } from "./lib.ts";

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
    report: async (id: string): Promise<ReportState | null> =>
      (await call(`reports?id=eq.${id}&select=id,status,content_version,rendered_version`))?.[0] ?? null,
    // Only if the status is still what we saw, so a Hold clicked meanwhile wins.
    scheduleNow: async (id: string, from: string): Promise<boolean> =>
      ((await call(`reports?id=eq.${id}&status=eq.${from}`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({ status: "scheduled", send_at: new Date().toISOString() }),
      })) ?? []).length === 1,
  };
}

async function dispatch(workflow: "send.yml" | "render.yml", reportId: string, force = false) {
  const { url, init } = dispatchRequest(env("REPORTS_REPO"), workflow, reportId, env("GH_ACTIONS_TOKEN"), force);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (res.status !== 204) {
    const detail = res.status === 401 ? "the GitHub token has expired or was revoked" : `GitHub answered ${res.status}`;
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

  let action, reportId;
  try {
    ({ action, reportId } = parseAction(await readBody(req)));
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message }, headers);
    throw e;
  }

  const db = asUser(authorization);
  try {
    if (!(await db.isAdmin())) return reply(403, { error: "Only an admin who finished MFA can do this." }, headers);
    const r = await db.report(reportId);
    if (!r) return reply(404, { error: "Report not found." }, headers);
    const no = refusal(r);
    if (no) return reply(409, { error: no }, headers);

    if (action === "render") {
      if (renderIsCurrent(r)) return reply(200, { ok: true, started: null }, headers);
      await dispatch("render.yml", reportId);
      return reply(200, { ok: true, started: "render" }, headers);
    }
    if (action === "rebuild") {
      await dispatch("render.yml", reportId, true);
      return reply(200, { ok: true, started: "render" }, headers);
    }

    if (!(await db.scheduleNow(reportId, r.status))) return reply(409, { error: "The report changed a moment ago. Reload and try again." }, headers);
    await dispatch("send.yml", reportId);
    return reply(200, { ok: true, started: "send" }, headers);
  } catch (e) {
    const err = e as Error & { status?: number; github?: boolean; dbMessage?: string };
    console.error("report-action", action, reportId, err.message);
    if (err.github) {
      const what = action === "send_now" ? "It's marked to send now, but the send didn't start" : action === "rebuild" ? "The rebuild didn't start" : "The preview didn't start updating";
      return reply(502, { error: `${what}: ${err.message}. Try again in a minute.` }, headers);
    }
    if (err.status === 401) return reply(401, { error: "Sign in again." }, headers);
    if (err.status === 400 || err.status === 403) return reply(409, { error: err.dbMessage || "The database refused that change." }, headers);
    return reply(503, { error: "Try again." }, headers);
  }
});
