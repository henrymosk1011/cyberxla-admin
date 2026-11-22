// Request checks and rules for audit-action, kept apart from the HTTP handler
// so they can be tested. Mirrors report-action.

export const ALLOWED_ORIGINS = new Set(["https://admin.cyberx.la"]);
export const MAX_BODY_BYTES = 2 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class BadRequest extends Error {}

// scan/rescan: run (or re-run) the scan. rebuild: re-render the PDF. send_now:
// send the report. copy: email Henry a copy (any done audit, changes nothing).
// cancel: stop a queued or running scan. scan_pending: drain the queue (one run
// scans every queued audit), for a bulk "Scan now" or auto-scan after discovery;
// it takes no audit_id because the queue was just filled by scan_prospects().
export type Action = "scan" | "rescan" | "rebuild" | "send_now" | "copy" | "cancel" | "scan_pending";
export const ACTIONS: readonly Action[] = ["scan", "rescan", "rebuild", "send_now", "copy", "cancel", "scan_pending"];

export type AuditState = {
  id: string;
  scan_status: "queued" | "running" | "done" | "failed" | "cancelled";
  delivery: "none" | "sending" | "sent" | "failed";
};

/** { action, audit_id } from the dashboard, or BadRequest. scan_pending is the
 *  one action that carries no audit_id: it drains the whole queue. */
export function parseAction(body: unknown): { action: Action; auditId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "action" && k !== "audit_id")) throw new BadRequest("body");
  if (!ACTIONS.includes(b.action as Action)) throw new BadRequest("action");
  if (b.action === "scan_pending") {
    if (b.audit_id !== undefined) throw new BadRequest("audit_id"); // a drain takes no id
    return { action: "scan_pending", auditId: "" };
  }
  if (typeof b.audit_id !== "string" || !UUID.test(b.audit_id)) throw new BadRequest("audit_id");
  return { action: b.action as Action, auditId: b.audit_id.toLowerCase() };
}

/** Which workflow an action dispatches, or null when the action is only a database change. */
export function workflowFor(action: Action): Workflow | null {
  if (action === "scan" || action === "rescan") return "audit-scan.yml";
  if (action === "rebuild") return "audit-render.yml";
  if (action === "send_now" || action === "copy") return "audit-send.yml";
  return null; // cancel
}

// The audit workflows live in the patch-reports repo, so they carry an audit-
// prefix to avoid colliding with its own send.yml / render.yml.
export type Workflow = "audit-scan.yml" | "audit-send.yml" | "audit-render.yml";

/** The GitHub call that starts a workflow for one audit. force (render only)
 *  renders even when up to date; copy (send only) emails Henry a copy. */
export function dispatchRequest(repo: string, workflow: Workflow, id: string | null, token: string, force = false, copy = false) {
  if (!REPO.test(repo)) throw new Error("AUDIT_REPO must look like owner/name");
  if (id !== null && !UUID.test(id)) throw new Error("bad audit id");
  // id null = drain: the runner scans every queued audit (no single target).
  const inputs = id === null ? {}
    : force && workflow === "audit-render.yml" ? { audit_id: id, force: "true" }
    : copy && workflow === "audit-send.yml" ? { audit_id: id, copy: "true" }
    : { audit_id: id };
  return {
    url: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cyberxla-admin-audit-action",
      },
      body: JSON.stringify({ ref: "main", inputs }),
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
