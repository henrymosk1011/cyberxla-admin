// Services and prices come from the quote function's catalog (one source of
// truth, checked against the website by scripts/check-catalog.mjs). This file
// only adds the website's category grouping for the "Add service" picker.
import { CATALOG, priceQuote } from "../../../supabase/functions/submit-quote/lib.ts";

export { CATALOG, priceQuote };

export const CATEGORIES: { name: string; ids: string[] }[] = [
  { name: "Protect devices", ids: ["patching", "edr", "ransomware", "encryption", "hardening", "firewall"] },
  { name: "Monitor and respond", ids: ["mdr", "domain", "darkweb", "cloudmon", "irretainer", "irplan"] },
  { name: "Email and identity", ids: ["filtering", "training", "dmarc", "mfa", "passwords", "access"] },
  { name: "Test and assess", ids: ["pentest", "vuln", "risk", "surface"] },
  { name: "Backup and recovery", ids: ["cloudbackup", "devbackup", "restore", "drplan"] },
  { name: "Insurance and compliance", ids: ["insurance", "hipaa", "policies", "questionnaire"] },
];

const UNIT: Record<string, string> = { dev: "/device/mo", mo: "/mo", once: "one time", devonce: "/device, one time" };

/** "$10 /device/mo", "from $5,000 one time" */
export function unitPrice(id: string): string {
  const s = CATALOG[id];
  if (!s) return "";
  return `${s.from ? "from " : ""}$${s.price.toLocaleString("en-US")} ${UNIT[s.unit]}`;
}
