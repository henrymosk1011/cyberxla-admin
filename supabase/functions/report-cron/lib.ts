// Request checks and rules for report-cron, kept apart from the HTTP handler
// so they can be tested.

export const MAX_BODY_BYTES = 256;
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const HEX64 = /^[0-9a-f]{64}$/;

export class BadRequest extends Error {}

// generate: Generate reports, acting exactly like its Sunday schedule (it
// checks the generate time and makes each report once). send: Send reports
// for every report that is due (each is claimed in one step, so it can't go
// twice). unifi: Check UniFi status for every client with a console.
export type Job = "generate" | "send" | "unifi";
export const JOBS: readonly Job[] = ["generate", "send", "unifi"];

/** { job } from pg_cron, or BadRequest. */
export function parseJob(body: unknown): Job {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "job")) throw new BadRequest("body");
  if (!JOBS.includes(b.job as Job)) throw new BadRequest("job");
  return b.job as Job;
}

/** The workflow each job starts, with its inputs. */
export function jobWorkflow(job: Job): { workflow: string; inputs: Record<string, string> } {
  if (job === "generate") return { workflow: "generate.yml", inputs: { scheduled: "true" } };
  if (job === "send") return { workflow: "send.yml", inputs: {} };
  return { workflow: "unifi-check.yml", inputs: {} };
}

/** The GitHub call that starts a job's workflow on main. */
export function dispatchRequest(repo: string, job: Job, token: string) {
  if (!REPO.test(repo)) throw new Error("REPORTS_REPO must look like owner/name");
  const { workflow, inputs } = jobWorkflow(job);
  return {
    workflow,
    url: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cyberxla-admin-report-cron",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  };
}

/** Lowercase hex SHA-256 of a string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant time compare of two hex strings (false if either isn't 64 hex characters). */
export function sameHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The token pg_cron sends is right when its SHA-256 matches the stored hash. */
export async function tokenMatches(token: string, hash: string): Promise<boolean> {
  if (!HEX64.test(token)) return false;
  return sameHex(await sha256Hex(token), hash.trim().toLowerCase());
}
