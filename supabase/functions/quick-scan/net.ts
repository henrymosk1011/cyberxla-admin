// A fetch only network adapter for the scan engine, so it can run inside an Edge
// Function where raw TLS sockets and DNS resolvers aren't available. Compared to
// the Actions runner's adapter (lib/audit/net.js in the scanner repo):
//   * DNS (SPF, DMARC, MX, CAA) goes through DNS over HTTPS (dns.google).
//   * The certificate isn't read directly; the handler treats a successful
//     HTTPS load as proof the certificate is currently valid (fetch rejects an
//     expired or untrusted certificate), and notes that depth is a quick scan
//     limitation. The full audit reads the real certificate.
//   * HTTPS redirect is inferred from the final URL after following redirects,
//     since Edge fetch can't read a manual redirect's Location.
// Everything else (headers, cookies, stale libraries, crt.sh subdomains) is the
// same signal the full scan uses.

import type { Net, Observations } from "./scan.ts";

const UA = "cyberxLA-security-audit/0.1 (+https://cyberx.la)";
const TIMEOUT = 10_000;

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { redirect: "follow", ...init, headers: { "User-Agent": UA, "Accept": "text/html,*/*", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
}

/** One DNS over HTTPS lookup, returning the raw record data strings. */
async function doh(name: string, type: "TXT" | "MX" | "CAA"): Promise<string[]> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { headers: { "Accept": "application/dns-json" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const j = await res.json().catch(() => null) as { Status?: number; Answer?: { type?: number; data?: string }[] } | null;
    if (!j || !Array.isArray(j.Answer)) return [];
    return j.Answer.map((a) => a.data).filter((d): d is string => typeof d === "string");
  } catch {
    return [];
  }
}

/** DNS over HTTPS returns TXT values quoted, and long ones split into chunks. */
function unquoteTxt(data: string): string {
  const out: string[] = [];
  let inQ = false, cur = "";
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === '"') { if (inQ) { out.push(cur); cur = ""; } inQ = !inQ; }
    else if (inQ) cur += c;
  }
  return out.length ? out.join("") : data.replace(/^"|"$/g, "");
}

export const fetchNet: Net = {
  async fetchPage(url) {
    const res = await get(url, { redirect: "follow" });
    const headers: Record<string, string> = {};
    for (const [k, v] of res.headers) headers[k] = v;
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (headers["set-cookie"] ? [headers["set-cookie"]] : []);
    const body = await res.text();
    return { status: res.status, headers, setCookies, body, finalUrl: res.url };
  },

  async httpsRedirect(domain) {
    try {
      const res = await get("http://" + domain, { redirect: "follow" });
      // Followed to HTTPS means http is redirected up; still on http means not.
      try { return new URL(res.url).protocol === "https:"; } catch { return false; }
    } catch {
      return true; // http refused outright is usually an HTTPS only site
    }
  },

  // Edge functions can't open a raw TLS socket. Return null; the handler treats a
  // successful HTTPS page load as proof the certificate is currently valid.
  tlsCert(_host): Promise<Observations["tls"]> {
    return Promise.resolve(null);
  },

  async txt(name) {
    return (await doh(name, "TXT")).map(unquoteTxt);
  },
  async mx(name) {
    return (await doh(name, "MX")).map((d) => d.trim().split(/\s+/).pop()!.replace(/\.$/, "")).filter(Boolean);
  },
  async caa(name) {
    return (await doh(name, "CAA")).map((d) => d.trim()).filter(Boolean);
  },

  async ctSubdomains(domain) {
    try {
      const res = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) { await res.body?.cancel(); return []; }
      const rows = await res.json().catch(() => null) as { name_value?: string }[] | null;
      if (!Array.isArray(rows)) return [];
      const set = new Set<string>();
      for (const r of rows) {
        for (const nm of String(r.name_value || "").split("\n")) {
          const n = nm.trim().toLowerCase();
          if (n && !n.startsWith("*") && n.endsWith(domain)) set.add(n);
        }
      }
      return [...set].slice(0, 100);
    } catch {
      return [];
    }
  },
};
