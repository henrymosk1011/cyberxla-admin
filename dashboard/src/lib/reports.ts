// Patch report rules the dashboard shows and enforces before the database does.
import { dateTime, shortDate } from "./format.ts";
import type { ReportContent, ReportRow, ReportStatus, Tone } from "./types.ts";

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  scheduled: "Scheduled", held: "On hold", sending: "Sending", sent: "Sent", failed: "Failed", cancelled: "Cancelled",
};

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The send job skips a report more than this late (reports repo, reporting.claim). */
export const SEND_GRACE_MS = 24 * HOUR;
/** The hourly send job should have picked a due report up by now. */
const LATE_MS = 90 * MIN;
/** A send that hasn't finished by now is probably stuck. */
const STUCK_MS = 15 * MIN;

/** "in 3h 12m", "in 2d 4h", "now" */
export function countdown(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return "now";
  const mins = Math.ceil(diff / MIN);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type StateTone = "good" | "warn" | "bad" | "info" | "lime" | "muted";
export type ReportState = { label: string; tone: StateTone; note: string };
type StateInput = Pick<ReportRow, "status" | "send_at" | "sent_at" | "claimed_at" | "error" | "is_test">;

/** What a report's status means right now, in words (status pills are text, never color alone). */
export function reportState(r: StateInput, now = Date.now()): ReportState {
  const due = new Date(r.send_at).getTime();
  switch (r.status) {
    case "scheduled":
      if (r.is_test) return { label: "Scheduled", tone: "warn", note: "Test reports never send on a schedule. Use Send now." };
      if (now - due > SEND_GRACE_MS) return { label: "Missed", tone: "bad", note: "Missed its send time and won't go out on its own. Use Send now." };
      if (now - due > LATE_MS) return { label: "Late", tone: "warn", note: "Past its send time. The next hourly send run (Mondays until 3 PM) picks it up, or use Send now." };
      return { label: "Scheduled", tone: "lime", note: `Sends ${countdown(r.send_at, now)} (${dateTime(r.send_at)})` };
    case "held":
      if (r.is_test) return { label: "On hold", tone: "warn", note: "Test report: only Send now sends it, and only to you." };
      return { label: "On hold", tone: "warn", note: "Won't send until you resume it or use Send now." };
    case "sending": {
      const since = r.claimed_at ? new Date(r.claimed_at).getTime() : now;
      return now - since > STUCK_MS
        ? { label: "Sending", tone: "bad", note: `Started ${dateTime(r.claimed_at!)} and hasn't finished. Check Sent Items in reports@cyberx.la, then mark it sent or not sent.` }
        : { label: "Sending", tone: "info", note: "Going out now." };
    }
    case "sent":
      return { label: "Sent", tone: "good", note: r.sent_at ? `Sent ${dateTime(r.sent_at)}` : "Sent" };
    case "failed":
      return { label: "Failed", tone: "bad", note: r.error || "The send failed." };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", note: "Won't send." };
  }
}

/** Which buttons a report gets. */
export function reportActions(r: StateInput, now = Date.now()) {
  const locked = r.status === "sending" || r.status === "sent";
  const inWindow = now - new Date(r.send_at).getTime() <= SEND_GRACE_MS;
  return {
    edit: !locked,
    hold: r.status === "scheduled",
    // After the send window, resuming would never send; Send now is the way.
    resume: (r.status === "held" || r.status === "cancelled") && inWindow && !r.is_test,
    sendNow: r.status === "scheduled" || r.status === "held" || r.status === "failed" || r.status === "cancelled",
    cancel: r.status === "scheduled" || r.status === "held" || r.status === "failed",
    markSent: r.status === "sending",
    markNotSent: r.status === "sending",
    remove: r.status !== "sending" && (r.status !== "sent" || r.is_test),
  };
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
/** "Weekly, patch window Nov 6" or "Monthly, October 2026" */
export function periodLabel(r: Pick<ReportRow, "period" | "period_start">): string {
  return r.period === "weekly" ? `Weekly, patch window ${shortDate(r.period_start + "T12:00:00")}` : `Monthly, ${MONTH.format(new Date(r.period_start + "T12:00:00Z"))}`;
}

/** Reports grouped by the day they send (tests on their own), soonest last week first. */
export function groupBySend<T extends Pick<ReportRow, "send_at" | "is_test" | "client_name" | "period">>(rows: T[]) {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const groups = new Map<string, { key: string; label: string; at: number; rows: T[] }>();
  for (const r of rows) {
    const d = new Date(r.send_at);
    const key = r.is_test ? "test" : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groups.has(key)) groups.set(key, { key, label: r.is_test ? "Test reports" : `Sending ${day.format(d)}`, at: r.is_test ? -Infinity : d.getTime(), rows: [] });
    groups.get(key)!.rows.push(r);
  }
  for (const g of groups.values()) g.rows.sort((a, b) => a.client_name.localeCompare(b.client_name) || (a.period === "weekly" ? -1 : 1));
  return [...groups.values()].sort((a, b) => b.at - a.at);
}

/** Reports in the current send window: what Hold all and Resume all act on. */
export function thisWeek<T extends Pick<ReportRow, "send_at" | "is_test" | "status">>(rows: T[], now = Date.now()) {
  const live = rows.filter((r) => !r.is_test && now - new Date(r.send_at).getTime() <= SEND_GRACE_MS);
  return {
    toHold: live.filter((r) => r.status === "scheduled"),
    toResume: live.filter((r) => r.status === "held" && new Date(r.send_at).getTime() > now),
  };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** The same rule as the database's emails_ok(). */
export const EMAIL = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/i;

/** "a@x.com, B@y.com; c@z" -> { emails: ["a@x.com", "b@y.com"], invalid: ["c@z"] } */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const parts = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return { emails: parts.filter((e) => EMAIL.test(e) && e.length <= 254), invalid: parts.filter((e) => !EMAIL.test(e) || e.length > 254) };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const ok = (s: string) => /^success$/i.test(s.trim());

/**
 * Fill the four headline numbers and the pill from the computers table, the
 * way the generator does: managed, patched (weekly) or patched every week
 * (monthly), updates installed, need attention. Hidden computers don't count.
 */
export function recalcKpis(c: ReportContent): ReportContent {
  const shown = c.computers.list.filter((r) => !r.hidden);
  const n = shown.length;
  const attention = shown.filter((r) => r.tone !== "good").length;
  const installs = shown.reduce((s, r) => s + (Number(r.updates.count) || 0), 0);
  const second = c.period === "weekly"
    ? shown.filter((r) => ok(r.run)).length
    : shown.filter((r) => {
        const m = r.run.match(/^(\d+)\s+of\s+(\d+)$/);
        return !!m && m[1] === m[2];
      }).length;
  const values = [String(n), `${second}/${n}`, String(installs), String(attention)];
  return {
    ...c,
    kpis: c.kpis.map((k, i) => (i < 4 ? { ...k, value: values[i]! } : k)),
    pill: attention ? { text: `${attention} needs attention`, tone: "warn" } : { text: "All clear", tone: "lime" },
  };
}

/** Every string in a value, with where it is ("computers.list[2].name"). */
export function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

// House rule: no dashes used as punctuation. Hyphens inside words and IDs are fine.
const DASH = /[\u2012\u2013\u2014\u2015]|--|\s-\s/;
export const hasDash = (s: string) => DASH.test(s);
/** Paths of fields that use a dash as punctuation. */
export const dashFields = (value: unknown) => strings(value).filter(([, s]) => hasDash(s)).map(([p]) => p);

const TONE_SET = new Set<Tone>(["good", "warn", "bad", "info", "lime"]);

/** Why content can't be rendered, or null. The same checks as validateContent() in the reports repo. */
export function contentProblem(c: unknown): string | null {
  const isText = (v: unknown) => typeof v === "string";
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(c)) return "The content must be a JSON object.";
  if (c.v !== 1) return "v must be 1.";
  if (c.period !== "weekly" && c.period !== "monthly") return "period must be weekly or monthly.";
  for (const k of ["doc_title", "label", "title", "subtitle", "headline", "updates_title"]) if (!isText(c[k])) return `${k} must be text.`;
  if (!isObj(c.pill) || !isText(c.pill.text)) return "pill.text must be text.";
  if (!TONE_SET.has(c.pill.tone as Tone)) return "pill.tone must be good, warn, bad, info or lime.";
  if (!Array.isArray(c.kpis)) return "kpis must be a list.";
  for (const [i, k] of c.kpis.entries()) if (!isObj(k) || !isText(k.value) || !isText(k.label)) return `kpis[${i}] needs a value and a label (both text).`;
  if (c.weeks !== null && c.weeks !== undefined) {
    if (!isObj(c.weeks) || !Array.isArray(c.weeks.bars)) return "weeks.bars must be a list (or set weeks to null).";
    for (const [i, b] of c.weeks.bars.entries()) if (!isObj(b) || !Number.isFinite(b.pct)) return `weeks.bars[${i}].pct must be a number.`;
  }
  if (!isObj(c.did) || !Array.isArray(c.did.items)) return "did.items must be a list.";
  if (!isObj(c.computers) || !Array.isArray(c.computers.columns) || !Array.isArray(c.computers.list)) return "computers needs columns and list.";
  for (const [i, r] of c.computers.list.entries()) {
    if (!isObj(r) || !isText(r.name)) return `computers.list[${i}].name must be text.`;
    if (!isObj(r.updates) || !Array.isArray(r.updates.items)) return `computers.list[${i}].updates.items must be a list.`;
    if (!TONE_SET.has(r.tone as Tone)) return `computers.list[${i}].tone must be good, warn, bad, info or lime.`;
  }
  if (!isObj(c.security) || !isText(c.security.text) || !Array.isArray(c.security.apps)) return "security needs text and apps.";
  if (!isObj(c.next_window) || !isText(c.next_window.when)) return "next_window.when must be text.";
  return null;
}

/** A computer row the admin adds by hand. */
export const blankComputer = (): ReportContent["computers"]["list"][number] => ({
  name: "New computer", run: "Success", pending: "0", crit: "0", status: "Protected", tone: "good", hidden: false,
  updates: { count: 0, items: [], empty: "Already up to date. Nothing new to install." },
});

/** What Send now will do, for its confirmation. */
export function sendNowText(r: Pick<ReportRow, "is_test" | "recipients" | "cc">, mode: "preview" | "live"): string {
  const to = r.recipients.join(", ");
  const cc = r.cc.length ? ` (cc ${r.cc.join(", ")})` : "";
  const fresh = "The PDF is rebuilt from your latest saved edits first.";
  if (r.is_test) return `This is a test report, so it goes to you only, tagged for ${to}${cc}. ${fresh}`;
  if (mode === "preview") return `Preview mode: it goes to you only, tagged for ${to}${cc}. Switch to live in Settings to send to the client. ${fresh}`;
  return `Live: it goes to ${to}${cc} right now, with replies to you. ${fresh}`;
}

// ---------------------------------------------------------------------------
// Always leave off
// ---------------------------------------------------------------------------

const normName = (s: string) => s.trim().toLowerCase();

/** Whether a computer name is on a client's leave off list (any case, as the Sunday run matches). */
export const isLeftOff = (list: readonly string[] | null | undefined, name: string) =>
  (list ?? []).some((n) => normName(n) === normName(name));

/** One name per line (or commas) -> a clean list: trimmed, no blanks, no repeats (any case). */
export function parseNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (!n || seen.has(normName(n))) continue;
    seen.add(normName(n));
    out.push(n);
  }
  return out;
}

/** The list with a name added or taken out. */
export const withName = (list: readonly string[], name: string, on: boolean) =>
  on ? (isLeftOff(list, name) ? [...list] : [...list, name.trim()]) : list.filter((n) => normName(n) !== normName(name));
