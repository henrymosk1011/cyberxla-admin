// Request checks for quick-scan, kept apart from the handler so they can be
// tested. The function runs a passive scan of a URL the admin types in, before
// deciding whether to add it as a prospect.

export const ALLOWED_ORIGINS = new Set(["https://admin.cyberx.la"]);
export const MAX_BODY_BYTES = 2 * 1024;

export class BadRequest extends Error {}

export type ScanParams = { target: string; domain: string };

/** Hosts the function must not be pointed at, so an admin can't aim the server
 *  side fetch at the local network. Public sites only. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h === "::1" || h === "[::1]") return false;
  // Literal IPv4 in a private, loopback, link local or unspecified range.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a >= 224) return false; // multicast / reserved
  }
  // Must look like a real domain (a dot and a letter TLD), or be a bare public IP.
  if (!m && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return false;
  return true;
}

/** { url } from the dashboard, normalized to { target, domain }, or BadRequest. */
export function parseParams(body: unknown): ScanParams {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "url")) throw new BadRequest("body");
  if (typeof b.url !== "string") throw new BadRequest("url");
  let raw = b.url.trim();
  if (!raw || raw.length > 300) throw new BadRequest("url");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/+/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequest("url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadRequest("url");
  const host = u.hostname.toLowerCase();
  if (!isPublicHost(host)) throw new BadRequest("url");
  u.hash = "";
  u.username = "";
  u.password = "";
  const domain = host.replace(/^www\./, "");
  return { target: u.toString(), domain };
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
