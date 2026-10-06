// Pricing helpers over the live service catalog (public.services, managed on
// the Services page). The same pricing code runs in the quote function.
import { priceQuote as price, type Catalog } from "../../../supabase/functions/submit-quote/lib.ts";
import type { ServiceRow, Unit } from "./types.ts";

export type { Catalog };

export const UNIT_LABEL: Record<Unit, string> = {
  dev: "/device/mo",
  mo: "/mo",
  once: "one time",
  devonce: "/device, one time",
};

export const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: "dev", label: "Per device, monthly" },
  { value: "mo", label: "Flat, monthly" },
  { value: "once", label: "Flat, one time" },
  { value: "devonce", label: "Per device, one time" },
];

export const isMonthly = (u: Unit) => u === "dev" || u === "mo";

export function toCatalog(services: ServiceRow[]): Catalog {
  const out: Catalog = Object.create(null);
  for (const s of services) out[s.id] = { name: s.name, price: s.price, unit: s.unit, from: s.price_from };
  return out;
}

export function priceQuote(services: ServiceRow[], ids: string[], ws: number, sv: number) {
  return price(toCatalog(services), ids, ws, sv);
}

/** "$10 /device/mo", "from $5,000 one time" */
export function unitPrice(s: Pick<ServiceRow, "price" | "unit" | "price_from"> | undefined): string {
  if (!s) return "";
  const p = Number.isInteger(s.price) ? s.price.toLocaleString("en-US") : s.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s.price_from ? "from " : ""}$${p} ${UNIT_LABEL[s.unit]}`;
}

/** What one line costs for a client with these devices (servers count 2.5x for per-device monthly). */
export function lineAmount(s: Pick<ServiceRow, "price" | "unit">, workstations: number, servers: number): number {
  const n = s.unit === "dev" ? workstations + servers * 2.5 : s.unit === "devonce" ? workstations + servers : 1;
  return Math.round(s.price * n * 100) / 100;
}

/** "Dark Web Monitoring" -> "dark-web-monitoring", unique against taken ids. */
export function slugify(name: string, taken: Iterable<string> = []): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "item";
  const used = new Set(taken);
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}
