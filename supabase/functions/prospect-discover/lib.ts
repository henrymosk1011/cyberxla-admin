// Request checks and mapping for prospect-discover, kept apart from the HTTP
// handler so they can be tested. Mirrors audit-action / report-action.
//
// The dashboard's "Find businesses" button sends { term, location, limit,
// source }. We search a business directory for `term` in `location`, turn each
// result into the prospect shape prospecting.add_prospects() expects
// (business_name, website, domain, phone, city, region, industry, source,
// source_ref) and insert the batch; that function de-dupes on
// (source, source_ref) and returns how many were newly added.
//
// Discovery reuses the Apify API source and the APIFY_TOKEN secret the
// lead-finder function already uses (Apify's Google Maps Scraper,
// compass/crawler-google-places), rather than adding a new directory key. That
// scraper is the project's one proven, high-volume directory source, so both
// the Google Places and the Yelp options discover through it; each prospect is
// recorded with its true source, google_places. A dedicated Yelp provider can
// be added later without changing this function's request or response shape.

export const ALLOWED_ORIGINS = new Set(["https://admin.cyberx.la"]);
export const MAX_BODY_BYTES = 2 * 1024;
// Matches the dashboard's form (How many: 1 to 50).
export const MAX_LIMIT = 50;
export const SOURCES = ["yelp", "google_places"] as const;
export type Source = (typeof SOURCES)[number];

// Apify's Google Maps Scraper, the same actor lead-finder uses.
export const ACTOR = "compass~crawler-google-places";
// Where discovered prospects are recorded, whichever directory option was
// picked: this is the directory we actually query.
export const DISCOVERY_SOURCE: Source = "google_places";

export class BadRequest extends Error {}

export type DiscoverParams = { term: string; location: string; limit: number; source: Source };

/** The prospect shape prospecting.add_prospects() reads from each array item. */
export type Prospect = {
  business_name: string;
  website: string | null;
  domain: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  industry: string | null;
  source: Source;
  source_ref: string | null;
};

/** One place as Apify's Google Maps Scraper returns it (only the fields we read). */
export type Place = {
  title?: string | null;
  categoryName?: string | null;
  city?: string | null;
  state?: string | null;
  website?: string | null;
  phone?: string | null;
  placeId?: string | null;
  permanentlyClosed?: boolean | null;
};

/** The dataset fields we ask Apify for (everything else stays on Apify). */
export const PLACE_FIELDS = ["title", "categoryName", "city", "state", "website", "phone", "placeId", "permanentlyClosed"] as const;

function oneLine(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw new BadRequest(field);
  const s = v.normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length < min || s.length > max || /[\u0000-\u001F\u007F]/.test(s)) throw new BadRequest(field);
  return s;
}

/** { term, location, limit, source } from the dashboard, or BadRequest(field). */
export function parseParams(body: unknown): DiscoverParams {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "term" && k !== "location" && k !== "limit" && k !== "source")) throw new BadRequest("body");
  const term = oneLine(b.term, "term", 1, 120);
  const location = oneLine(b.location, "location", 1, 160);
  const limit = b.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new BadRequest("limit");
  if (!SOURCES.includes(b.source as Source)) throw new BadRequest("source");
  return { term, location, limit, source: b.source as Source };
}

/**
 * What the scraper is asked for: the term in the location, up to `limit`
 * places, in English, with none of the paid extras (detail pages, contacts,
 * reviews, images). The same cheap input lead-finder uses.
 */
export function apifyInput(params: DiscoverParams): Record<string, unknown> {
  return {
    searchStringsArray: [params.term],
    locationQuery: params.location,
    maxCrawledPlacesPerSearch: params.limit,
    language: "en",
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    includeWebResults: false,
    maxReviews: 0,
    maxImages: 0,
    maxQuestions: 0,
  };
}

const cut = (v: unknown, n: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, n) : null;
};

// Addresses that aren't the business's own site, so we don't store them as the
// website (we'd audit it). The business is still kept, just without a site.
const NOT_A_SITE = new Set([
  "facebook.com", "m.facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com",
  "youtube.com", "youtu.be", "yelp.com", "linktr.ee", "linkin.bio", "wa.me", "google.com", "goo.gl",
  "maps.app.goo.gl", "g.page", "sites.google.com", "business.site", "nextdoor.com", "pinterest.com",
  "tripadvisor.com", "doordash.com", "ubereats.com", "grubhub.com", "squareup.com", "booksy.com", "vagaro.com",
]);
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|_hs|ref$|ref_src$|y_source$)/i;
// Matches the public.prospects.domain CHECK: a lowercase apex domain.
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** The business's own website as a tidy https URL (<=300 chars), or null for
 *  none or a social / directory link. */
export function ownSite(raw: unknown): string | null {
  let s = (typeof raw === "string" ? raw : "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!DOMAIN_RE.test(host)) return null;
  if (NOT_A_SITE.has(host) || [...NOT_A_SITE].some((d) => host.endsWith(`.${d}`))) return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let out = u.href;
  if (out.endsWith("/") && u.pathname === "/" && !u.search) out = out.slice(0, -1);
  return out.length <= 300 ? out : null;
}

/** The apex domain of a tidy site URL, lowercase, matching the prospects CHECK, or null. */
export function apexDomain(site: string | null): string | null {
  if (!site) return null;
  let host: string;
  try {
    host = new URL(site).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  return host.length >= 3 && host.length <= 253 && DOMAIN_RE.test(host) ? host : null;
}

/**
 * Turn a run's places into prospect rows: skip permanently closed businesses and
 * ones with no name, cap every field to its column limit, and derive the site
 * and apex domain. De-duplicates the batch by provider id (placeId) so one run
 * can't send the same business twice.
 */
export function toProspects(items: unknown[]): Prospect[] {
  const out: Prospect[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    const p = (item ?? {}) as Place;
    if (p.permanentlyClosed === true) continue;
    const business_name = cut(p.title, 200);
    if (!business_name) continue;
    const source_ref = cut(p.placeId, 200);
    if (source_ref) {
      if (seen.has(source_ref)) continue;
      seen.add(source_ref);
    }
    const website = ownSite(p.website);
    out.push({
      business_name,
      website,
      domain: apexDomain(website),
      phone: cut(p.phone, 40),
      city: cut(p.city, 120),
      region: cut(p.state, 120),
      industry: cut(p.categoryName, 120),
      source: DISCOVERY_SOURCE,
      source_ref,
    });
  }
  return out;
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
