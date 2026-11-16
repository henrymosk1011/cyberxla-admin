// report-cron: the patch reports' schedule, run by the database.
//
// GitHub's own schedule skips runs when it is busy (on Monday Nov 16 2026 none
// of the hourly Send reports runs started, so the reports went out late), so
// pg_cron calls this function (migration 0018) and it starts the reports
// repo's workflow. The workflows decide what is due, so an extra start does
// nothing, and GitHub's schedules stay as a backup.
//
// 1. POST only, server to server: a request from a browser (with an Origin) is
//    refused, and the body is capped.
// 2. The caller must send the token pg_cron keeps in Vault (report_cron_token)
//    as x-cron-token. Only its SHA-256 is here (REPORT_CRON_HASH), so the token
//    never leaves the database. No service role key, no database calls.
// 3. Jobs: generate (Generate reports, as its Sunday schedule), send (Send
//    reports, every report due), unifi (Check UniFi status, every client).
//    Each can only start a workflow; none can pick a report or change one.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   REPORT_CRON_HASH  SHA-256 (hex) of the Vault secret report_cron_token
//   GH_ACTIONS_TOKEN  shared with report-action: the reports repo only, Actions read and write
//   REPORTS_REPO      shared with report-action: owner/name of the reports repo

import { BadRequest, MAX_BODY_BYTES, dispatchRequest, parseJob, tokenMatches } from "./lib.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: HEADERS });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  if (req.headers.has("origin")) return reply(403, { error: "forbidden" });

  try {
    if (!(await tokenMatches(req.headers.get("x-cron-token") ?? "", env("REPORT_CRON_HASH")))) return reply(401, { error: "unauthorized" });

    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BadRequest("size");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BadRequest("json");
    }
    const job = parseJob(body);

    const { workflow, url, init } = dispatchRequest(env("REPORTS_REPO"), job, env("GH_ACTIONS_TOKEN"));
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (res.status !== 204) {
      const detail = res.status === 401 ? "the GitHub token has expired or was revoked" : `GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
      console.error("report-cron", job, detail);
      return reply(502, { error: detail });
    }
    console.log("report-cron", job, "started", workflow);
    return reply(200, { ok: true, started: workflow });
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error: "invalid", field: e.message });
    console.error("report-cron", (e as Error).message);
    return reply(500, { error: (e as Error).message });
  }
});
