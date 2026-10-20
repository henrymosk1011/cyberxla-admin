// Timeline wording shared by the lead, client and project pages.
import { money, STATUS_LABEL } from "./format.ts";
import type { AuditEntry } from "./types.ts";

/** A client_services or project_services change: "Added Patching ($10 × 12 = $120/mo)". */
export function describeLine(a: AuditEntry): string {
  const n = a.new_data ?? {}, o = a.old_data ?? {};
  const amt = (d: Record<string, unknown>) => {
    const q = Number(d.quantity ?? 1), total = `${money(Number(d.amount ?? 0))}${d.billing === "monthly" ? "/mo" : " one time"}`;
    return q > 1 ? `${money(Number(d.unit_amount ?? 0))} × ${q} = ${total}` : total;
  };
  if (a.action === "insert") return `Added ${n.name} (${amt(n)})`;
  if (a.action === "delete") return `Removed ${o.name} (${amt(o)})`;
  if (n.amount !== o.amount || n.billing !== o.billing) return `${n.name}: ${amt(o)} → ${amt(n)}`;
  return `${n.name} updated`;
}

/** A change to a project row, as it reads on the project or its lead's/client's timeline. */
export function describeProject(a: AuditEntry): string {
  const n = a.new_data ?? {}, o = a.old_data ?? {};
  const name = String(n.name ?? o.name ?? "Project");
  if (a.action === "insert") return `Project ${name} added`;
  if (a.action === "delete") return `Project ${name} deleted`;
  if (n.status !== o.status) return `${name}: ${STATUS_LABEL[String(o.status)] ?? o.status} → ${STATUS_LABEL[String(n.status)] ?? n.status}`;
  if (n.client_id !== o.client_id || n.lead_id !== o.lead_id) return `${name} moved to ${n.client_id ? "a client" : "a lead"}`;
  if (n.name !== o.name) return `Project ${o.name} renamed to ${name}`;
  if (n.notes !== o.notes) return `${name}: notes updated`;
  return `${name}: details updated`;
}

/** Credentials are logged without their (encrypted) contents, so only the label shows. */
export function describeCredential(a: AuditEntry): string {
  const n = a.new_data ?? {}, o = a.old_data ?? {};
  if (a.action === "insert") return `Credential added: ${n.label}`;
  if (a.action === "delete") return `Credential removed: ${o.label}`;
  return n.label !== o.label ? `Credential renamed: ${o.label} → ${n.label}` : `Credential updated: ${n.label}`;
}
