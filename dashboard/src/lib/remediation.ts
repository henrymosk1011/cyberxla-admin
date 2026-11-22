// How to fix each finding, in plain steps a non expert can follow, including the
// exact record or header to add and provider by provider walkthroughs (GoDaddy,
// Cloudflare, and so on). Keyed by the scanner's stable finding ids (see the
// audit engine's analyze.js). remediationFor() returns null for findings that
// are already in good shape, so only real problems get a guide.
//
// House style: no dashes as punctuation. Hyphens inside names like
// strict-transport-security or _dmarc are part of the name, not punctuation.

export type FixStep = string;

export type Remediation = {
  /** One line: what fixing this actually means. */
  summary: string;
  /** Who usually does this, so it's clear whether it's a you job or a hand off. */
  who: string;
  /** Rough effort, to set expectations. */
  effort: string;
  /** Generic ordered steps that apply however the site is hosted. */
  steps: FixStep[];
  /** The exact value to paste (a DNS record, a response header), copyable. */
  snippet?: { label: string; code: string };
  /** Exact steps for the common providers, collapsed until opened. */
  providers?: { name: string; steps: FixStep[] }[];
  /** How to confirm it worked. */
  verify?: string;
  /** Optional plain language background links. */
  learn?: { label: string; url: string }[];
};

// --- Reusable provider walkthroughs -----------------------------------------

/** Adding one DNS record (TXT or CAA) at a given name, for the common registrars. */
function dnsProviders(recordType: "TXT" | "CAA", recordName: string): { name: string; steps: FixStep[] }[] {
  const nameText = recordName === "@" ? 'the root (Name "@", sometimes blank)' : `the name "${recordName}"`;
  return [
    { name: "GoDaddy", steps: [
      "Sign in at godaddy.com with the account that owns the domain.",
      "Open the account menu, choose My Products, find the domain, and click DNS (or Manage DNS).",
      `Under Records click Add, choose ${recordType} for the type, and set Name to ${recordName === "@" ? '"@"' : `"${recordName}"`}.`,
      "Paste the value below into the Value box, leave TTL at 1 hour, and Save.",
    ] },
    { name: "Cloudflare", steps: [
      "Sign in at dash.cloudflare.com and pick the domain.",
      "Open DNS, then Records.",
      `Click Add record, choose ${recordType}, and set Name to ${recordName === "@" ? '"@"' : `"${recordName}"`}.`,
      "Paste the value below into Content, leave Proxy status as DNS only, and Save.",
    ] },
    { name: "Namecheap", steps: [
      "Sign in at namecheap.com, open Domain List, and click Manage next to the domain.",
      "Open the Advanced DNS tab.",
      `Under Host Records click Add New Record, choose ${recordType} Record, and set Host to ${recordName === "@" ? '"@"' : `"${recordName}"`}.`,
      "Paste the value below into Value, leave TTL Automatic, and save with the green check.",
    ] },
    { name: "Google Domains or Squarespace", steps: [
      "Sign in at domains.squarespace.com (Google Domains moved there) and pick the domain.",
      "Open DNS and find the custom records section.",
      `Add a record, choose ${recordType}, and set Host to ${recordName === "@" ? '"@"' : `"${recordName}"`}.`,
      "Paste the value below into Data, then Save.",
    ] },
    { name: "Somewhere else", steps: [
      "Sign in wherever the domain's DNS lives. It's usually the registrar you bought the domain from, or Cloudflare if the site uses it.",
      "Find DNS management, DNS records, or the zone editor.",
      `Add a ${recordType} record at ${nameText}.`,
      "Paste the value below as the record's value and save. DNS changes can take up to an hour to take effect.",
    ] },
  ];
}

/** Sending one HTTP response header on every page, for the common hosts and CDNs. */
function headerProviders(): { name: string; steps: FixStep[] }[] {
  return [
    { name: "Cloudflare", steps: [
      "In the Cloudflare dashboard pick the domain, then open Rules, Transform Rules, Modify Response Header.",
      "Create a rule that matches all incoming requests.",
      "Add a Set static action with the header name and value from the snippet below, then Deploy.",
    ] },
    { name: "Netlify", steps: [
      "Add or edit a file named _headers at the root of your published site.",
      'Add a line "/*" on its own, then the header below indented two spaces under it.',
      "Commit and let it deploy.",
    ] },
    { name: "Vercel", steps: [
      "Open vercel.json at the project root (create it if it isn't there).",
      'Add a headers entry whose source is "/(.*)" with the header name and value below.',
      "Commit and redeploy.",
    ] },
    { name: "nginx", steps: [
      "Edit your server block (often under /etc/nginx/sites-available).",
      "Add an add_header line inside server { } using the name and value below.",
      "Run nginx -t to test, then reload nginx.",
    ] },
    { name: "Apache", steps: [
      "Make sure mod_headers is enabled, then edit your site config or the .htaccess file at the site root.",
      'Add a line: Header always set <name> "<value>" using the snippet below.',
      "Reload Apache.",
    ] },
    { name: "WordPress or a no code host", steps: [
      "If you can't edit server files, add the header with a plugin (a security headers plugin for WordPress) or ask your host's support to set it.",
      "Give them the header name and value from the snippet below.",
    ] },
  ];
}

const forceHttpsProviders: { name: string; steps: FixStep[] }[] = [
  { name: "Cloudflare", steps: [
    "Pick the domain, open SSL/TLS, then Edge Certificates.",
    "Turn on Always Use HTTPS.",
  ] },
  { name: "Netlify or Vercel", steps: [
    "Open the site's domain settings.",
    "Turn on Force HTTPS (Netlify) or confirm the automatic HTTPS redirect is on (Vercel).",
  ] },
  { name: "cPanel host", steps: [
    "Open Domains in cPanel.",
    "Switch on Force HTTPS Redirect next to the domain.",
  ] },
  { name: "nginx", steps: [
    "In the port 80 server block add: return 301 https://$host$request_uri;",
    "Run nginx -t, then reload nginx.",
  ] },
  { name: "Apache", steps: [
    "In .htaccess (with mod_rewrite on) add a rule that rewrites http to https for all requests.",
    "Reload Apache and test an http:// link.",
  ] },
];

// --- The catalog ------------------------------------------------------------

const CATALOG: Record<string, Remediation> = {
  // Transport / TLS
  "tls-expired": {
    summary: "Renew the expired certificate now. Until you do, visitors get a full page security warning and most leave.",
    who: "Your web host, or whoever set up the certificate",
    effort: "Urgent, usually under an hour",
    steps: [
      "Find where the certificate came from: your host's control panel, Let's Encrypt or Certbot, or Cloudflare.",
      "Renew or reissue it and install it on the site.",
      "Turn on automatic renewal so it can't lapse again.",
    ],
    providers: [
      { name: "Let's Encrypt or Certbot", steps: ["On the server run: sudo certbot renew", "If that fails, reissue with certbot certonly, then reload your web server.", "Confirm the renewal timer is active: systemctl list-timers | grep certbot"] },
      { name: "cPanel host", steps: ["Open SSL/TLS Status in cPanel.", "Tick the domain and click Run AutoSSL.", "If AutoSSL is off, ask your host to enable it so renewals are automatic."] },
      { name: "Cloudflare", steps: ["Cloudflare manages the edge certificate for you.", "If the warning is on the origin, renew the certificate on your own server, or use a Cloudflare Origin Certificate."] },
    ],
    verify: "Open the site in a fresh browser tab: the warning should be gone and the padlock back. Then re-run this audit.",
  },
  "tls-expiring": {
    summary: "The certificate is close to expiring. Renew it now so it never lapses into a browser warning.",
    who: "Your web host, or whoever set up the certificate",
    effort: "15 to 30 minutes",
    steps: [
      "Renew the certificate through whoever issued it (host panel, Certbot, or Cloudflare).",
      "Most important: turn on automatic renewal so this stops being a manual job.",
    ],
    providers: [
      { name: "Let's Encrypt or Certbot", steps: ["Run: sudo certbot renew", "Make sure the certbot renewal timer is enabled so it renews on its own."] },
      { name: "cPanel host", steps: ["Open SSL/TLS Status and confirm AutoSSL is on for the domain."] },
    ],
    verify: "Re-run this audit, or check the certificate's expiry date in your browser (click the padlock).",
  },
  "tls-old-proto": {
    summary: "Turn off the old, weak TLS versions and require TLS 1.2 or newer.",
    who: "Your web host or CDN",
    effort: "10 minutes",
    steps: [
      "Set the minimum TLS version to 1.2 wherever TLS is terminated (your CDN or your server).",
      "Almost no real visitors still need 1.0 or 1.1, so this is low risk.",
    ],
    providers: [
      { name: "Cloudflare", steps: ["Open SSL/TLS, then Edge Certificates.", "Set Minimum TLS Version to 1.2."] },
      { name: "nginx", steps: ["In your TLS config set: ssl_protocols TLSv1.2 TLSv1.3;", "Run nginx -t, then reload nginx."] },
      { name: "Apache", steps: ["Set: SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1", "Reload Apache."] },
    ],
    verify: "Re-run this audit, or test the domain on a public SSL checker.",
  },
  "tls-unknown": {
    summary: "The scan couldn't read the certificate directly. Often this is fine, as long as the site loads over HTTPS with no browser warning.",
    who: "No action unless the site shows a warning",
    effort: "A minute to check",
    steps: [
      "Open the site over https:// in a browser. If the padlock is there and there's no warning, the certificate is working.",
      "If you do see a warning, treat it like an expired or misconfigured certificate and renew or reinstall it.",
    ],
    verify: "Re-run this audit; the certificate often reads fine on a second try.",
  },
  "no-https-redirect": {
    summary: "Send every visitor to the secure HTTPS version of the site, so traffic can't be read or tampered with on shared networks.",
    who: "Your web host or CDN",
    effort: "10 minutes",
    steps: [
      "Confirm HTTPS already works on the site (it does, or this finding wouldn't mention a redirect).",
      "Turn on the always use HTTPS setting, or add a redirect from http to https.",
    ],
    providers: forceHttpsProviders,
    verify: "Visit the site with http:// in front: it should jump to https://. Then re-run this audit.",
  },

  // Security headers
  "hsts": {
    summary: "Tell browsers to always use HTTPS for this site, closing a small window where a first visit could be downgraded.",
    who: "Your web host, CDN, or developer",
    effort: "10 minutes",
    steps: [
      "Make sure HTTPS works everywhere first. HSTS is sticky in browsers and awkward to undo.",
      "Send the response header below on every page.",
      "If you want to be cautious, start with a smaller max-age (say 86400) and raise it once you're confident.",
    ],
    snippet: { label: "Response header", code: "Strict-Transport-Security: max-age=31536000; includeSubDomains" },
    providers: headerProviders(),
    verify: "In your browser's Network tab, click the main document and look for the header in the response. Or re-run this audit.",
    learn: [{ label: "HSTS explained (MDN)", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security" }],
  },
  "csp": {
    summary: "Add a Content Security Policy so that if a bad script ever gets injected, the browser won't run it.",
    who: "Your developer (CSP needs a little tuning)",
    effort: "An hour or two, done carefully",
    steps: [
      "Start in report only mode so nothing breaks: send Content-Security-Policy-Report-Only with a starter policy.",
      "Watch what gets reported, then widen the policy to allow only the sources your site really uses.",
      "When it's clean, switch the header name to Content-Security-Policy to actually enforce it.",
    ],
    snippet: { label: "Starter policy (report only first)", code: "Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" },
    providers: headerProviders(),
    verify: "Load the site and check the console for CSP reports, then re-run this audit once you enforce it.",
    learn: [{ label: "Content Security Policy (MDN)", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP" }],
  },
  "nosniff": {
    summary: "Stop browsers from guessing a file's type, which can turn a harmless upload into a running script.",
    who: "Your web host, CDN, or developer",
    effort: "5 minutes",
    steps: ["Send the one response header below on every response. It's safe and rarely breaks anything."],
    snippet: { label: "Response header", code: "X-Content-Type-Options: nosniff" },
    providers: headerProviders(),
    verify: "Re-run this audit, or look for the header in your browser's Network tab.",
  },
  "xfo": {
    summary: "Stop other websites from loading yours inside a hidden frame, which is how clickjacking tricks people.",
    who: "Your web host, CDN, or developer",
    effort: "5 minutes",
    steps: [
      "Send the response header below so only your own site can frame your pages.",
      "If you use a Content Security Policy, you can instead add: frame-ancestors 'self'.",
    ],
    snippet: { label: "Response header", code: "X-Frame-Options: SAMEORIGIN" },
    providers: headerProviders(),
    verify: "Re-run this audit, or check the response headers in your browser.",
  },
  "referrer": {
    summary: "Stop full page URLs from leaking to other sites in the Referer header.",
    who: "Your web host, CDN, or developer",
    effort: "5 minutes",
    steps: ["Send the response header below. This value is a sensible default that keeps analytics working."],
    snippet: { label: "Response header", code: "Referrer-Policy: strict-origin-when-cross-origin" },
    providers: headerProviders(),
    verify: "Re-run this audit, or look for the header in your browser's Network tab.",
  },
  "mixed": {
    summary: "Load every image, script, and style over HTTPS. Mixed content weakens the secure page and browsers may block it.",
    who: "Your developer",
    effort: "30 minutes",
    steps: [
      "Open the page and your browser console; mixed content is flagged there with the exact URLs.",
      "Change each http:// resource to https://. Most providers already serve both.",
      "If something has no HTTPS version, host a copy yourself or swap in an HTTPS alternative.",
    ],
    verify: "Reload the page: the console should show no mixed content warnings. Then re-run this audit.",
  },

  // Information disclosure / software
  "banner": {
    summary: "Stop your server from announcing its exact software versions in response headers, which hands an attacker a head start.",
    who: "Your web host or developer",
    effort: "15 minutes",
    steps: [
      "Hide or genericize the Server and X-Powered-By headers.",
      "This doesn't make you safer on its own, but it stops advertising which known exploits to try.",
    ],
    providers: [
      { name: "nginx", steps: ["Add: server_tokens off;", "To drop an upstream header add: proxy_hide_header X-Powered-By;", "Reload nginx."] },
      { name: "Apache", steps: ["Set: ServerTokens Prod and ServerSignature Off", "To remove the app header add (mod_headers): Header always unset X-Powered-By", "Reload Apache."] },
      { name: "PHP", steps: ["In php.ini set: expose_php = Off", "Restart PHP or your web server."] },
      { name: "Cloudflare", steps: ["Use Transform Rules, Modify Response Header, Remove to strip Server or X-Powered-By at the edge."] },
    ],
    verify: "Re-run this audit, or check the response headers in your browser's Network tab.",
  },
  "lib": {
    summary: "Update the outdated front end library this page loads. The finding names the library and version.",
    who: "Whoever maintains the website (your developer)",
    effort: "30 to 60 minutes, plus a quick test",
    steps: [
      "Find where the library loads: a <script> or <link> tag in the page, or an entry in the project's package.json.",
      "Update it to the current supported version.",
      "If it loads from a CDN link, bump the version number in the URL. If it comes from a build, update the package and rebuild.",
      "Click through the site's interactive parts afterward to make sure nothing broke.",
    ],
    verify: "Re-run this audit; the finding clears once the page loads a current version.",
  },

  // Cookies
  "cookies": {
    summary: "Set the Secure, HttpOnly and SameSite flags on cookies, especially the session cookie, so they can't leak or be read by injected scripts.",
    who: "Your developer or platform setting",
    effort: "20 minutes",
    steps: [
      "Find where cookies are set: usually your framework's session settings, or a cookie or security plugin.",
      "Turn on Secure (HTTPS only), HttpOnly (not readable by JavaScript), and SameSite (Lax is a good default).",
      "Apply it to the session cookie first, then any others that hold anything sensitive.",
    ],
    providers: [
      { name: "WordPress", steps: ["Session cookies are handled by WordPress and your host. Use a security plugin that sets cookie flags, or ask your host to enable Secure and HttpOnly."] },
      { name: "Express (Node)", steps: ["In your session setup use cookie: { secure: true, httpOnly: true, sameSite: 'lax' }.", "Behind a proxy also set app.set('trust proxy', 1)."] },
      { name: "PHP", steps: ["Set session.cookie_secure = 1, session.cookie_httponly = 1, session.cookie_samesite = \"Lax\" in php.ini, or via session_set_cookie_params()."] },
    ],
    verify: "In your browser's Application or Storage tab, check the cookies show Secure and HttpOnly. Then re-run this audit.",
  },

  // Email spoofing (DNS)
  "spf": {
    summary: "Add an SPF record naming which servers may send email for your domain. It cuts spoofing and improves deliverability.",
    who: "Whoever manages the domain's DNS",
    effort: "15 minutes",
    steps: [
      "List every service that sends mail as you: Google Workspace, Microsoft 365, your newsletter or CRM tool, and so on.",
      "Add one TXT record at the root of the domain with an include for each sender. The snippet below is a Google Workspace example.",
      "Keep it to a single SPF record. If you have several senders, merge their includes into one line.",
    ],
    snippet: { label: "TXT record at the root (Google Workspace example)", code: "v=spf1 include:_spf.google.com ~all" },
    providers: dnsProviders("TXT", "@"),
    verify: "Re-run this audit, or look up your root TXT record with any SPF checker.",
  },
  "dmarc": {
    summary: "Publish a DMARC record so nobody can send email that looks like it's from your domain. This is a common route for invoice and payroll fraud.",
    who: "Whoever manages the domain's DNS",
    effort: "15 minutes to start, safe to roll out",
    steps: [
      "Pick an inbox to receive the reports (for example dmarc@yourdomain).",
      "Add the TXT record below at the name _dmarc. Start with p=none so no mail is blocked while you watch the reports.",
      "After a week or two of clean reports, change p=none to p=quarantine, then later to p=reject for full protection.",
    ],
    snippet: { label: "TXT record at _dmarc", code: "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com" },
    providers: dnsProviders("TXT", "_dmarc"),
    verify: "Re-run this audit, or look up the _dmarc TXT record with any DMARC checker.",
    learn: [{ label: "What DMARC does", url: "https://dmarc.org/overview/" }],
  },
  "dmarc-weak": {
    summary: "Your DMARC is set to monitor only, so spoofed mail still gets delivered. Move it to enforcing.",
    who: "Whoever manages the domain's DNS",
    effort: "10 minutes, after a quick look at reports",
    steps: [
      "Check your DMARC reports for a week or two to be sure your real mail passes.",
      "Edit the _dmarc TXT record and change p=none to p=quarantine.",
      "Once that looks clean, change it to p=reject for full protection.",
    ],
    snippet: { label: "Updated TXT record at _dmarc", code: "v=DMARC1; p=reject; rua=mailto:dmarc@yourdomain.com" },
    providers: dnsProviders("TXT", "_dmarc"),
    verify: "Re-run this audit; the finding clears once the policy is quarantine or reject.",
  },
  "caa": {
    summary: "Add CAA records so only your certificate authority can issue certificates for the domain. Low urgency, good hygiene.",
    who: "Whoever manages the domain's DNS",
    effort: "10 minutes",
    steps: [
      "Decide which certificate authority you use (Let's Encrypt for most automated setups, or your host's).",
      "Add the CAA record below at the root. The example allows Let's Encrypt; use your authority's identifier if different.",
    ],
    snippet: { label: "CAA record at the root (Let's Encrypt example)", code: '0 issue "letsencrypt.org"' },
    providers: dnsProviders("CAA", "@"),
    verify: "Re-run this audit, or look up the domain's CAA records with a DNS checker.",
  },

  // Attack surface
  "ct": {
    summary: "Review the subdomains that show up in public certificate logs. This is about awareness: each one is a door worth keeping locked.",
    who: "You, with your developer or host",
    effort: "20 minutes to review",
    steps: [
      "These names are already public (anyone can read certificate transparency logs), so there's nothing to hide here, just to check.",
      "Go through the list and confirm each subdomain is meant to be reachable and is kept patched.",
      "Retire anything you no longer use, and keep internal only tools off public certificates where you can.",
    ],
    verify: "No single fix. Re-run this audit after retiring unused subdomains and the count updates.",
  },
};

/** The fix guide for a finding id, or null when nothing needs doing. Dynamic ids
 *  like lib-jquery fall back to the shared "lib" entry. */
export function remediationFor(id: string): Remediation | null {
  const direct = CATALOG[id];
  if (direct) return direct;
  if (id.startsWith("lib-")) return CATALOG["lib"] ?? null;
  return null;
}
