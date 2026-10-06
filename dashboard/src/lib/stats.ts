import { LEAD_STATUSES, OPEN_STATUSES, type Lead, type LeadStatus, type Quote } from "./types.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Monday 00:00 local time of the week containing d. */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const inRange = (iso: string, from: number, to: number) => {
  const t = new Date(iso).getTime();
  return t >= from && t < to;
};

export type Kpis = {
  newLeads: number;
  newLeadsPrev: number;
  quotes: number;
  quotesPrev: number;
  openMonthly: number;
  openOneTime: number;
  openCount: number;
  wonMonthly: number;
  winRate: number | null;
  avgMonthly: number | null;
};

/** Headline numbers for the last `weeks` weeks, with the equal period before it for deltas. */
export function kpis(leads: Lead[], quotes: Quote[], weeks: number, now = new Date()): Kpis {
  const to = now.getTime() + 1, from = to - weeks * WEEK, prev = from - weeks * WEEK;
  const open = leads.filter((l) => OPEN_STATUSES.includes(l.status));
  const closed = leads.filter((l) => (l.status === "won" || l.status === "lost") && inRange(l.updated_at, from, to));
  const won = closed.filter((l) => l.status === "won");
  const periodQuotes = quotes.filter((q) => inRange(q.created_at, from, to) && q.monthly_total > 0);
  return {
    newLeads: leads.filter((l) => inRange(l.created_at, from, to)).length,
    newLeadsPrev: leads.filter((l) => inRange(l.created_at, prev, from)).length,
    quotes: quotes.filter((q) => inRange(q.created_at, from, to)).length,
    quotesPrev: quotes.filter((q) => inRange(q.created_at, prev, from)).length,
    openMonthly: sum(open.map((l) => l.value_monthly)),
    openOneTime: sum(open.map((l) => l.value_one_time)),
    openCount: open.length,
    wonMonthly: sum(won.map((l) => l.value_monthly)),
    winRate: closed.length ? won.length / closed.length : null,
    avgMonthly: periodQuotes.length ? sum(periodQuotes.map((q) => q.monthly_total)) / periodQuotes.length : null,
  };
}

export type WeekBucket = { start: Date; count: number; monthly: number; oneTime: number };

/** Quotes per week, oldest first, always `weeks` buckets ending with the current week. */
export function weekly(quotes: Quote[], weeks: number, now = new Date()): WeekBucket[] {
  const last = weekStart(now);
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(last);
    start.setDate(start.getDate() - i * 7);
    buckets.push({ start, count: 0, monthly: 0, oneTime: 0 });
  }
  const first = buckets[0]!.start.getTime();
  for (const q of quotes) {
    const t = new Date(q.created_at);
    if (t.getTime() < first) continue;
    const b = buckets.find((b, i) => t >= b.start && (i === buckets.length - 1 || t < buckets[i + 1]!.start));
    if (!b) continue;
    b.count++;
    b.monthly += q.monthly_total;
    b.oneTime += q.one_time_total;
  }
  return buckets;
}

export type Stage = { status: LeadStatus; count: number; monthly: number; oneTime: number };

export function stages(leads: Lead[]): Stage[] {
  return LEAD_STATUSES.map((status) => {
    const ls = leads.filter((l) => l.status === status);
    return { status, count: ls.length, monthly: sum(ls.map((l) => l.value_monthly)), oneTime: sum(ls.map((l) => l.value_one_time)) };
  });
}

export type ServiceCount = { id: string; name: string; count: number; share: number };

/** How many quotes in the period asked for each service, most requested first. */
export function topServices(quotes: Quote[], weeks: number, limit = 8, now = new Date()): ServiceCount[] {
  const from = now.getTime() + 1 - weeks * WEEK;
  const qs = quotes.filter((q) => new Date(q.created_at).getTime() >= from);
  const counts = new Map<string, ServiceCount>();
  for (const q of qs) {
    for (const it of q.items) {
      const c = counts.get(it.id) ?? { id: it.id, name: it.name, count: 0, share: 0 };
      c.count++;
      counts.set(it.id, c);
    }
  }
  return [...counts.values()]
    .map((c) => ({ ...c, share: qs.length ? c.count / qs.length : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Clean axis ticks from 0 to a round number at or above max. */
export function ticks(max: number, target = 4, integer = false): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag).filter((s) => !integer || s >= 1);
  const step = steps.find((s) => s >= raw) ?? steps[steps.length - 1]!;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
