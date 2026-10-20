// Who a project is for: a client or a lead, as one select value ("client:<id>" or "lead:<id>").
import type { Client, Lead } from "./types.ts";

export type Owner = { lead_id: string | null; client_id: string | null };
export type OwnerOption = { value: string; label: string };

export const clientLabel = (c: Client) => c.company || c.contact_name || "Unnamed client";
export const leadLabel = (l: Lead) => l.company || l.name;

export const ownerValue = (o: Owner) => (o.client_id ? `client:${o.client_id}` : `lead:${o.lead_id}`);

export function parseOwner(v: string): Owner | null {
  const m = v.match(/^(client|lead):(.+)$/);
  if (!m) return null;
  return m[1] === "client" ? { client_id: m[2]!, lead_id: null } : { lead_id: m[2]!, client_id: null };
}

/** Clients (active first), and leads that are still open: not archived and not already a client. `keep` stays listed regardless. */
export function ownerOptions(clients: Client[], leads: Lead[], keep?: Owner): { clients: OwnerOption[]; leads: OwnerOption[] } {
  const converted = new Set(clients.map((c) => c.lead_id));
  const rank = { active: 0, paused: 1, former: 2 };
  return {
    clients: [...clients]
      .sort((a, b) => rank[a.status] - rank[b.status] || clientLabel(a).localeCompare(clientLabel(b)))
      .map((c) => ({ value: `client:${c.id}`, label: clientLabel(c) + (c.status === "active" ? "" : ` (${c.status})`) })),
    leads: leads
      .filter((l) => l.id === keep?.lead_id || (!l.archived_at && !converted.has(l.id)))
      .sort((a, b) => leadLabel(a).localeCompare(leadLabel(b)))
      .map((l) => ({ value: `lead:${l.id}`, label: leadLabel(l) })),
  };
}
