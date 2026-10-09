<script lang="ts">
  import db from "$db";
  import Modal from "./Modal.svelte";
  import { buildTable, download, FIELDS, GROUPS, toCSV, toXLSX, type Ctx } from "../lib/export.ts";
  import type { Client, Lead, Note, Quote } from "../lib/types.ts";

  let { open, onclose, leads, shown, quotes, clients }: {
    open: boolean; onclose: () => void;
    leads: Lead[]; shown: Lead[]; quotes: Quote[]; clients: Client[];
  } = $props();

  const STORE = "cx-export-v1";
  type Saved = { fields: string[]; format: "xlsx" | "csv"; scope: "shown" | "active" | "everything" };
  function restore(): Saved {
    const d: Saved = { fields: FIELDS.filter((f) => f.on).map((f) => f.key), format: "xlsx", scope: "shown" };
    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Saved> | null;
      if (!s) return d;
      return {
        fields: Array.isArray(s.fields) ? s.fields.filter((k) => FIELDS.some((f) => f.key === k)) : d.fields,
        format: s.format === "csv" ? "csv" : "xlsx",
        scope: s.scope === "active" || s.scope === "everything" ? s.scope : "shown",
      };
    } catch { return d; }
  }
  const init = restore();
  let picked = $state(new Set(init.fields));
  let format = $state(init.format);
  let scope = $state(init.scope);
  let busy = $state(false);
  let error = $state("");

  const active = $derived(leads.filter((l) => !l.archived_at));
  const target = $derived(scope === "shown" ? shown : scope === "active" ? active : leads);
  const chosen = $derived(FIELDS.filter((f) => picked.has(f.key)));

  function toggle(key: string, on: boolean) {
    const next = new Set(picked);
    on ? next.add(key) : next.delete(key);
    picked = next;
  }
  function setGroup(group: string, on: boolean) {
    const next = new Set(picked);
    for (const f of FIELDS) if (f.group === group) on ? next.add(f.key) : next.delete(f.key);
    picked = next;
  }

  async function go() {
    if (!chosen.length || !target.length) return;
    error = "";
    busy = true;
    try {
      // Newest active quote per lead (quotes arrive newest-last or unsorted, so compare).
      const latest = new Map<string, Quote>();
      for (const q of quotes) {
        if (q.archived_at) continue;
        const cur = latest.get(q.lead_id);
        if (!cur || q.created_at > cur.created_at) latest.set(q.lead_id, q);
      }
      const notes = new Map<string, Note[]>();
      if (picked.has("notes")) for (const n of await db.allNotes()) notes.set(n.lead_id, [...(notes.get(n.lead_id) ?? []), n]);
      const byLead = new Map(clients.filter((c) => c.lead_id).map((c) => [c.lead_id!, c]));
      const ctx = (l: Lead): Ctx => ({ quote: latest.get(l.id), notes: notes.get(l.id) ?? [], client: byLead.get(l.id) });

      const table = buildTable(target, chosen, ctx);
      const stamp = new Date().toLocaleDateString("en-CA"); // 2026-10-09
      if (format === "csv") download(toCSV(table), `cyberxla-leads-${stamp}.csv`, "text/csv;charset=utf-8");
      else download(toXLSX(table) as BlobPart, `cyberxla-leads-${stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

      try { localStorage.setItem(STORE, JSON.stringify({ fields: [...picked], format, scope } satisfies Saved)); } catch { /* private mode */ }
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't build the export.";
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title="Export leads" {onclose} wide>
  <div class="ex">
    <fieldset>
      <legend class="eyebrow">Which leads</legend>
      <div class="opts">
        <label class="opt"><input type="radio" name="ex-scope" value="shown" bind:group={scope} /> What's on screen <span class="muted num">{shown.length}</span></label>
        <label class="opt"><input type="radio" name="ex-scope" value="active" bind:group={scope} /> All active leads <span class="muted num">{active.length}</span></label>
        <label class="opt"><input type="radio" name="ex-scope" value="everything" bind:group={scope} /> Everything, including archived <span class="muted num">{leads.length}</span></label>
      </div>
    </fieldset>

    <fieldset>
      <legend class="eyebrow">Columns <span class="muted">{chosen.length} of {FIELDS.length}</span></legend>
      <div class="groups">
        {#each GROUPS as g (g)}
          {@const fs = FIELDS.filter((f) => f.group === g)}
          {@const all = fs.every((f) => picked.has(f.key))}
          <div class="group">
            <div class="ghead">
              <span>{g}</span>
              <button type="button" class="link" onclick={() => setGroup(g, !all)}>{all ? "None" : "All"}</button>
            </div>
            {#each fs as f (f.key)}
              <label class="check"><input type="checkbox" checked={picked.has(f.key)} onchange={(e) => toggle(f.key, e.currentTarget.checked)} /> {f.label}</label>
            {/each}
          </div>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend class="eyebrow">Format</legend>
      <div class="seg" role="group" aria-label="File format">
        <button type="button" aria-pressed={format === "xlsx"} onclick={() => (format = "xlsx")}>Excel (.xlsx)</button>
        <button type="button" aria-pressed={format === "csv"} onclick={() => (format = "csv")}>CSV</button>
      </div>
    </fieldset>

    <p class="muted hint">The file downloads straight to this computer; nothing is sent anywhere. It contains customer contact details, so store it somewhere private.</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
      <button type="button" class="btn primary" disabled={busy || !chosen.length || !target.length} onclick={go}>
        {busy ? "Preparing…" : `Download ${target.length} ${target.length === 1 ? "lead" : "leads"}`}
      </button>
    </div>
  </div>
</Modal>

<style>
  .ex { display: flex; flex-direction: column; gap: 18px; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { margin-bottom: 8px; padding: 0; }
  legend .muted { text-transform: none; letter-spacing: 0; font-weight: 500; margin-left: 6px; }
  .opts { display: flex; flex-direction: column; gap: 6px; }
  .opt, .check { display: flex; align-items: center; gap: 9px; font-size: 14px; cursor: pointer; color: var(--text-2); }
  .opt .num { margin-left: auto; }
  input[type="radio"], input[type="checkbox"] { accent-color: var(--lime); width: 16px; height: 16px; flex: none; }
  .groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .group { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }
  .ghead { display: flex; justify-content: space-between; align-items: center; font-weight: 650; font-size: 14px; margin-bottom: 2px; }
  .link { border: 0; background: none; color: var(--lime); font-size: 12px; font-weight: 600; padding: 2px 4px; border-radius: 6px; }
  .link:hover { background: var(--surface-2); }
  .hint { font-size: 12px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  @media (max-width: 560px) { .groups { grid-template-columns: 1fr; } }
</style>
