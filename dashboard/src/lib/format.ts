const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const money = (n: number) => usd0.format(Math.round(n));
export const moneyCompact = (n: number) => (Math.abs(n) >= 10_000 ? "$" + compact.format(n) : money(n));
export const num = (n: number) => n.toLocaleString("en-US");

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dateYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function shortDate(iso: string | Date) {
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? dateFmt : dateYearFmt).format(d);
}
export const dateTime = (iso: string) => `${shortDate(iso)}, ${timeFmt.format(new Date(iso))}`;

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return shortDate(iso);
}

export const STATUS_LABEL: Record<string, string> = {
  new: "New", contacted: "Contacted", proposal: "Proposal", won: "Won", lost: "Lost",
  active: "Active", paused: "Paused", former: "Former",
  submitted: "Submitted", reviewing: "Reviewing", sent: "Sent", accepted: "Accepted", declined: "Declined",
};

/** Display a US number as (818) 714-1066. Anything else is shown as entered. */
export function phone(raw: string | null | undefined): string {
  if (!raw) return "";
  const ext = raw.match(/\s*(?:ext\.?|x)\s*(\d+)\s*$/i);
  const d = (ext ? raw.slice(0, ext.index) : raw).replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}${ext ? ` ext. ${ext[1]}` : ""}`;
}
