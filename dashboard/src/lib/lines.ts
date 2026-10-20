// Totals for priced service lines (client_services, project_services).
import { money } from "./format.ts";
import type { ServiceLine } from "./types.ts";

export type LineTotals = { monthly: number; once: number; n: number };

/** Monthly and one-time totals per owner, e.g. totalsBy(lines, (l) => l.client_id). */
export function totalsBy<T extends ServiceLine>(lines: T[], key: (l: T) => string): Map<string, LineTotals> {
  const m = new Map<string, LineTotals>();
  for (const l of lines) {
    const t = m.get(key(l)) ?? { monthly: 0, once: 0, n: 0 };
    if (l.billing === "monthly") t.monthly += l.amount; else t.once += l.amount;
    t.n++;
    m.set(key(l), t);
  }
  return m;
}

/** "$8,000 + $120/mo", "$8,000", "$120/mo", or "–" for nothing priced yet. */
export function valueLabel(t: LineTotals | undefined): string {
  if (!t || (!t.once && !t.monthly)) return "–";
  if (!t.monthly) return money(t.once);
  if (!t.once) return `${money(t.monthly)}/mo`;
  return `${money(t.once)} + ${money(t.monthly)}/mo`;
}
