// The passive scan engine, ported from the canonical scanner in
// cyberxla-patch-reports (lib/audit/collect.js and lib/audit/analyze.js). Keep
// the finding ids, weights, thresholds and grade bands in sync with that file:
// the quick scan here and the full audit there must agree on how a site scores.
//
// Everything is pure and takes an injected `net` adapter (see net.ts), so the
// same logic runs over fetch in this Edge Function and over raw sockets in the
// Actions runner.

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type Finding = {
  id: string;
  category: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  recommendation?: string;
  service?: string;
  passed?: boolean;
};

export type Observations = {
  target: string;
  domain: string;
  host: string;
  reachable: boolean;
  httpsOnly: boolean | null;
  finalUrl: string | null;
  http: { status: number; headers: Record<string, string>; setCookies: string[]; bodySample: string } | null;
  tls: { ok: boolean; issuer: string | null; valid_from?: string; valid_to?: string | null; daysLeft: number | null; expired: boolean; protocol: string | null; altNames?: string | null } | null;
  dns: { checked: boolean; spf?: string | null; dmarc?: string | null; dmarcPolicy?: string | null; mx?: string[]; caa?: string[] };
  ct: { subdomains: string[] } | null;
  errors: string[];
};

export type Net = {
  fetchPage(url: string): Promise<{ status: number; headers: Record<string, string>; setCookies: string[]; body: string; finalUrl: string }>;
  httpsRedirect(domain: string): Promise<boolean>;
  tlsCert(host: string): Promise<Observations["tls"]>;
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<string[]>;
  caa(name: string): Promise<string[]>;
  ctSubdomains(domain: string): Promise<string[]>;
};

// --- collect -----------------------------------------------------------------

export function normalizeUrl(target: string): string {
  let t = String(target || "").trim();
  if (!t) throw new Error("no target");
  if (!/^https?:\/\//i.test(t)) t = "https://" + t;
  const u = new URL(t);
  u.hash = "";
  return u.toString();
}

export const hostOf = (url: string) => new URL(url).hostname;
export const apexish = (host: string) => host.replace(/^www\./, "").toLowerCase();

export function pickSpf(txts: string[]): string | null {
  return (txts || []).map(String).find((t) => /^v=spf1\b/i.test(t.trim())) || null;
}
export function pickDmarc(txts: string[]): string | null {
  return (txts || []).map(String).find((t) => /^v=DMARC1\b/i.test(t.trim())) || null;
}
export function dmarcPolicy(dmarc: string | null): string | null {
  if (!dmarc) return null;
  const m = dmarc.match(/;\s*p\s*=\s*(none|quarantine|reject)/i);
  return m ? m[1].toLowerCase() : null;
}

export async function collect(target: string, net: Net): Promise<Observations> {
  const url = normalizeUrl(target);
  const host = hostOf(url);
  const domain = apexish(host);
  const obs: Observations = { target: url, domain, host, reachable: false, httpsOnly: null, finalUrl: null, http: null, tls: null, dns: { checked: false }, ct: null, errors: [] };

  try {
    const page = await net.fetchPage(url);
    obs.reachable = true;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(page.headers || {})) headers[k.toLowerCase()] = v;
    obs.http = { status: page.status, headers, setCookies: page.setCookies || [], bodySample: String(page.body || "").slice(0, 250000) };
    obs.finalUrl = page.finalUrl || url;
  } catch (e) { obs.errors.push("http: " + (e as Error).message); }

  if (obs.reachable) {
    try { obs.httpsOnly = await net.httpsRedirect(domain); }
    catch (e) { obs.errors.push("redirect: " + (e as Error).message); }
  }

  try { obs.tls = await net.tlsCert(host); }
  catch (e) { obs.errors.push("tls: " + (e as Error).message); }

  try {
    const [root, dmarcTxt, mx, caa] = await Promise.all([
      net.txt(domain).catch(() => []),
      net.txt("_dmarc." + domain).catch(() => []),
      net.mx(domain).catch(() => []),
      net.caa(domain).catch(() => []),
    ]);
    const dmarc = pickDmarc(dmarcTxt);
    obs.dns = { checked: true, spf: pickSpf(root), dmarc, dmarcPolicy: dmarcPolicy(dmarc), mx: mx || [], caa: caa || [] };
  } catch (e) { obs.errors.push("dns: " + (e as Error).message); }

  try { obs.ct = { subdomains: (await net.ctSubdomains(domain)) || [] }; }
  catch (e) { obs.errors.push("ct: " + (e as Error).message); }

  return obs;
}

// --- analyze -----------------------------------------------------------------

const WEIGHT: Record<FindingSeverity, number> = { critical: 28, high: 15, medium: 8, low: 3, info: 0 };

const STALE_LIBS = [
  { name: "jQuery", re: /jquery[-.]?(\d+\.\d+\.\d+)(?:\.min)?\.js/i, badBelow: "3.5.0", service: "patching" },
  { name: "Bootstrap", re: /bootstrap[-.]?(\d+\.\d+\.\d+)(?:\.min)?\.(?:js|css)/i, badBelow: "4.3.1", service: "patching" },
  { name: "AngularJS", re: /angular[-.]?(1\.\d+\.\d+)(?:\.min)?\.js/i, badBelow: "1.8.3", service: "patching" },
];

function cmpVersion(a: string, b: string): number {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

const h = (headers: Record<string, string>, name: string) => headers?.[name.toLowerCase()] ?? null;

export function findingsFrom(obs: Observations): Finding[] {
  const f: Finding[] = [];
  const add = (x: Finding) => f.push(x);
  const headers = obs.http?.headers || {};

  if (obs.tls && obs.tls.ok) {
    if (obs.tls.expired) {
      add({ id: "tls-expired", category: "tls", severity: "critical", title: "TLS certificate has expired", detail: `The certificate expired on ${obs.tls.valid_to}. Visitors see browser security warnings and some will leave.`, recommendation: "Renew the certificate and set up auto renewal.", service: "surface" });
    } else if (typeof obs.tls.daysLeft === "number" && obs.tls.daysLeft <= 15) {
      add({ id: "tls-expiring", category: "tls", severity: "medium", title: "TLS certificate expires soon", detail: `The certificate expires in ${obs.tls.daysLeft} days (${obs.tls.valid_to}).`, recommendation: "Renew it now and turn on auto renewal so it never lapses.", service: "surface" });
    } else {
      add({ id: "tls-ok", category: "tls", severity: "info", title: "Valid, current TLS certificate", detail: `The certificate is valid${obs.tls.issuer ? ` (issued by ${obs.tls.issuer})` : ""} and not expiring soon.`, passed: true });
    }
    if (obs.tls.protocol && /TLSv1(\.0|\.1)?$/.test(obs.tls.protocol)) {
      add({ id: "tls-old-proto", category: "tls", severity: "medium", title: `Outdated TLS protocol (${obs.tls.protocol})`, detail: "The site negotiated an old TLS version with known weaknesses.", recommendation: "Require TLS 1.2 or higher and disable older versions.", service: "surface" });
    }
  } else if (obs.reachable) {
    add({ id: "tls-unknown", category: "tls", severity: "info", title: "Certificate could not be inspected", detail: "The scan could not read the TLS certificate directly.", passed: false });
  }

  if (obs.reachable && obs.httpsOnly === false) {
    add({ id: "no-https-redirect", category: "tls", severity: "high", title: "HTTP is not redirected to HTTPS", detail: "The site answers over plain HTTP without forcing HTTPS, so traffic can be read or tampered with on shared networks.", recommendation: "Redirect all HTTP requests to HTTPS.", service: "surface" });
  } else if (obs.httpsOnly === true) {
    add({ id: "https-ok", category: "tls", severity: "info", title: "HTTP redirects to HTTPS", detail: "Plain HTTP requests are sent to HTTPS.", passed: true });
  }

  const hsts = h(headers, "strict-transport-security");
  if (!hsts) add({ id: "hsts", category: "headers", severity: "medium", title: "HSTS is not enabled", detail: "Browsers are not told to stay on HTTPS, leaving a window for downgrade attacks on untrusted networks.", recommendation: "Send a Strict-Transport-Security header.", service: "surface" });
  else add({ id: "hsts-ok", category: "headers", severity: "info", title: "HSTS enabled", detail: "The site requires HTTPS with Strict-Transport-Security.", passed: true });

  if (!h(headers, "content-security-policy")) add({ id: "csp", category: "headers", severity: "medium", title: "No Content Security Policy", detail: "Nothing restricts which scripts the site may run, so an injected script would have free rein over visitor sessions.", recommendation: "Add a Content-Security-Policy header.", service: "surface" });
  if (!h(headers, "x-content-type-options")) add({ id: "nosniff", category: "headers", severity: "low", title: "Missing X-Content-Type-Options", detail: "Browsers may guess content types, which can turn a harmless upload into an executable script.", recommendation: "Send X-Content-Type-Options: nosniff.", service: "surface" });
  if (!h(headers, "x-frame-options") && !/frame-ancestors/i.test(h(headers, "content-security-policy") || "")) add({ id: "xfo", category: "headers", severity: "low", title: "No clickjacking protection", detail: "The site can be framed by other pages, which allows clickjacking of forms and buttons.", recommendation: "Add X-Frame-Options or a frame-ancestors policy.", service: "surface" });
  if (!h(headers, "referrer-policy")) add({ id: "referrer", category: "privacy", severity: "info", title: "No Referrer-Policy", detail: "Full URLs may leak to third-party sites in the Referer header.", recommendation: "Add a Referrer-Policy such as strict-origin-when-cross-origin.", service: "surface" });

  const banner = [h(headers, "server"), h(headers, "x-powered-by")].filter(Boolean).filter((v) => /\d/.test(v as string)) as string[];
  if (banner.length) add({ id: "banner", category: "exposure", severity: "low", title: "Software versions disclosed", detail: `Response headers reveal software versions (${banner.join("; ")}), which hands an attacker a head start on matching known exploits.`, recommendation: "Suppress or genericize Server and X-Powered-By headers.", service: "surface" });

  const body = obs.http?.bodySample || "";
  for (const lib of STALE_LIBS) {
    const m = body.match(lib.re);
    if (m && cmpVersion(m[1], lib.badBelow) < 0) {
      add({ id: `lib-${lib.name.toLowerCase()}`, category: "software", severity: "high", title: `Outdated ${lib.name} ${m[1]}`, detail: `The site loads ${lib.name} ${m[1]}, which is below ${lib.badBelow} and has published vulnerabilities.`, recommendation: `Update ${lib.name} to a current, supported release.`, service: lib.service });
    }
  }

  const cookies = obs.http?.setCookies || [];
  const weak = cookies.filter((c) => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c));
  if (cookies.length && weak.length) add({ id: "cookies", category: "cookies", severity: "medium", title: "Cookies missing Secure or HttpOnly", detail: `${weak.length} of ${cookies.length} cookies are set without the Secure or HttpOnly flags, so they can leak over plain HTTP or be read by injected scripts.`, recommendation: "Set Secure, HttpOnly and SameSite on cookies, especially session cookies.", service: "surface" });

  if (obs.httpsOnly && /\bsrc\s*=\s*["']http:\/\//i.test(body)) add({ id: "mixed", category: "headers", severity: "medium", title: "Mixed content on an HTTPS page", detail: "The page loads some resources over plain HTTP, which browsers may block and which weakens the page security.", recommendation: "Load every resource over HTTPS.", service: "surface" });

  const dns = obs.dns || { checked: false };
  if (dns.checked) {
    if (!dns.spf) add({ id: "spf", category: "email", severity: "medium", title: "No SPF record", detail: "There is no SPF record naming which servers may send mail for the domain, which weakens spoofing protection and hurts deliverability.", recommendation: "Add an SPF record listing your real mail providers.", service: "dmarc" });
    else add({ id: "spf-ok", category: "email", severity: "info", title: "SPF record present", detail: "The domain names which servers may send its mail.", passed: true });

    if (!dns.dmarc) add({ id: "dmarc", category: "email", severity: "high", title: "No DMARC record", detail: "The domain publishes no DMARC policy, so anyone can send email that appears to come from this business. This is a common route for invoice and payroll fraud.", recommendation: "Publish a DMARC record, starting at p=none and moving to p=reject once legitimate mail passes.", service: "dmarc" });
    else if (dns.dmarcPolicy === "none") add({ id: "dmarc-weak", category: "email", severity: "low", title: "DMARC is monitor only (p=none)", detail: "A DMARC record exists but only watches; spoofed mail is still delivered.", recommendation: "Move the DMARC policy to quarantine, then reject.", service: "dmarc" });
    else add({ id: "dmarc-ok", category: "email", severity: "info", title: `DMARC enforced (p=${dns.dmarcPolicy})`, detail: "The domain tells receivers to reject or quarantine spoofed mail.", passed: true });

    if (Array.isArray(dns.caa) && dns.caa.length === 0) add({ id: "caa", category: "dns", severity: "info", title: "No CAA records", detail: "Any certificate authority can issue certificates for this domain. CAA records restrict that to the ones you use.", recommendation: "Add CAA records for your certificate authority.", service: "surface" });
  }

  if (obs.ct && Array.isArray(obs.ct.subdomains) && obs.ct.subdomains.length) {
    add({ id: "ct", category: "exposure", severity: "info", title: `${obs.ct.subdomains.length} subdomains visible in public logs`, detail: `Certificate transparency logs expose subdomains such as ${obs.ct.subdomains.slice(0, 5).join(", ")}. Each is a possible entry point worth reviewing.`, passed: false });
  }

  return f;
}

export function scoreFrom(findings: Finding[]): number {
  let score = 100;
  for (const x of findings) { if (!x.passed) score -= (WEIGHT[x.severity] || 0); }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function gradeFrom(score: number): string {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : score >= 35 ? "E" : "F";
}

const SEV_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function summarize(findings: Finding[]): string {
  const problems = findings.filter((x) => !x.passed && x.severity !== "info");
  if (!problems.length) return "No external security issues found. A clean public posture.";
  const top = [...problems].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]).slice(0, 2).map((x) => x.title.toLowerCase());
  const n = problems.length;
  return `${n} issue${n === 1 ? "" : "s"} found, including ${top.join(" and ")}.`;
}

export const SCANNER_VERSION = "0.1.0";

export function analyze(obs: Observations): { findings: Finding[]; score: number; grade: string; summary: string; scanner_version: string } {
  const findings = findingsFrom(obs).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const score = scoreFrom(findings);
  const grade = gradeFrom(score);
  return { findings, score, grade, summary: summarize(findings), scanner_version: SCANNER_VERSION };
}
