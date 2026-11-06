// Request checks and rules for report-action, kept apart from the HTTP handler
// so they can be tested.

export const ALLOWED_ORIGINS = new Set(["https://admin.cyberx.la"]);
export const MAX_BODY_BYTES = 2 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class BadRequest extends Error {}

// render: bring the PDFs up to the latest edits. rebuild: build them again even
// if they're up to date (the Rebuild button). send_now: send it now.
export type Action = "render" | "rebuild" | "send_now";
export type ReportState = {
  id: string;
  status: "scheduled" | "held" | "sending" | "sent" | "failed" | "cancelled";
  content_version: number;
  rendered_version: number;
};

/** { action, report_id } from the dashboard, or BadRequest. */
export function parseAction(body: unknown): { action: Action; reportId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "action" && k !== "report_id")) throw new BadRequest("body");
  if (b.action !== "render" && b.action !== "rebuild" && b.action !== "send_now") throw new BadRequest("action");
  if (typeof b.report_id !== "string" || !UUID.test(b.report_id)) throw new BadRequest("report_id");
  return { action: b.action, reportId: b.report_id.toLowerCase() };
}

/** Why nothing can be done to this report any more, or null. Applies to every action. */
export function refusal(r: ReportState): string | null {
  if (r.status === "sending") return "This report is already sending.";
  if (r.status === "sent") return "This report was already sent.";
  return null;
}

/** Nothing to render: the PDFs already match the latest edits. */
export const renderIsCurrent = (r: ReportState) => r.rendered_version >= r.content_version;

/** The GitHub call that starts a workflow for one report. force (render.yml only) renders even if up to date. */
export function dispatchRequest(repo: string, workflow: "send.yml" | "render.yml", reportId: string, token: string, force = false) {
  if (!REPO.test(repo)) throw new Error("REPORTS_REPO must look like owner/name");
  if (!UUID.test(reportId)) throw new Error("bad report id");
  return {
    url: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cyberxla-admin-report-action",
      },
      body: JSON.stringify({ ref: "main", inputs: force && workflow === "render.yml" ? { report_id: reportId, force: "true" } : { report_id: reportId } }),
    },
  };
}

/** The public key for PostgREST calls: an explicit secret, the new key list, or the legacy anon key. */
export function publishableKey(get: (k: string) => string | undefined): string {
  const explicit = get("PUBLISHABLE_KEY");
  if (explicit) return explicit;
  const list = get("SUPABASE_PUBLISHABLE_KEYS");
  if (list) {
    try {
      const keys = JSON.parse(list) as Record<string, string>;
      const first = keys.default ?? Object.values(keys)[0];
      if (first) return first;
    } catch {
      // fall through to the legacy key
    }
  }
  const anon = get("SUPABASE_ANON_KEY");
  if (anon) return anon;
  throw new Error("missing publishable key (set the PUBLISHABLE_KEY secret)");
}
