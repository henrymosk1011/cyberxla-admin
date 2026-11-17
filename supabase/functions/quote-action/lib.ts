// Request checks for quote-action, kept apart from the HTTP handler so they
// can be tested (tests/quote-action.test.ts).

export const ALLOWED_ORIGINS = new Set(["https://admin.cyberx.la"]);
export const MAX_BODY_BYTES = 8 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadRequest extends Error {}

// send: Send now (freezes the next version, then emails it). resend: email the
// latest sent version again. test: Send me a test (to the notify address only;
// changes nothing). status: which secrets are set (email, Stripe). test_payment:
// a $1 Stripe Checkout to try the payment flow (only when Stripe is connected).
export type Action = "send" | "resend" | "test" | "status" | "test_payment";
export const ACTIONS: readonly Action[] = ["send", "resend", "test", "status", "test_payment"];

export type Parsed = { action: Action; id: string | null; subject: string; note: string };

// Line and paragraph separators, built from char codes so they can never end up raw in a regex literal.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LINE = new RegExp(`[\\u0000-\\u001F\\u007F${SEPARATORS}]`);
const TEXT = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F${SEPARATORS}]`);

/** { action, id, subject, note } from the dashboard, or BadRequest. */
export function parseAction(body: unknown): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !["action", "id", "subject", "note"].includes(k))) throw new BadRequest("body");
  if (!ACTIONS.includes(b.action as Action)) throw new BadRequest("action");
  const action = b.action as Action;
  if (action === "status" || action === "test_payment") return { action, id: null, subject: "", note: "" };
  if (typeof b.id !== "string" || !UUID.test(b.id)) throw new BadRequest("id");
  const subject = typeof b.subject === "string" ? b.subject.normalize("NFC").trim() : "";
  if (!subject || subject.length > 200 || LINE.test(subject)) throw new BadRequest("subject");
  const note = b.note === undefined || b.note === null ? "" : b.note;
  if (typeof note !== "string" || note.length > 2000 || TEXT.test(note)) throw new BadRequest("note");
  return { action, id: b.id.toLowerCase(), subject, note: note.normalize("NFC").trim() };
}

/** Who gets the email: the recipient and cc for the client, only the notify address for a test. */
export function recipients(action: Action, ctx: { to: string | null; cc: string[]; settings: { notify_email: string } }): { to: string[]; cc: string[] } {
  if (action === "test") return { to: [ctx.settings.notify_email], cc: [] };
  if (!ctx.to) throw new BadRequest("recipient");
  return { to: [ctx.to], cc: ctx.cc.filter((x) => x.toLowerCase() !== ctx.to!.toLowerCase()) };
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
