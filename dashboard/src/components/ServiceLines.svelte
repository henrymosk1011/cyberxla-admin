<script lang="ts">
  // The priced services on a client or project: add from the catalog or as a
  // custom line, change price x quantity inline, and see the totals.
  import Confirm from "./Confirm.svelte";
  import { catalog } from "../lib/store.svelte.ts";
  import { unitPrice } from "../lib/catalog.ts";
  import { money } from "../lib/format.ts";
  import type { ServiceLine, ServiceRow } from "../lib/types.ts";

  let { lines, devices, noun, sub, empty, hint, onadd, onupdate, onremove }: {
    lines: ServiceLine[];
    /** Per-device catalog services start at this quantity. */
    devices: number;
    /** "client" or "project", for the remove prompt. */
    noun: string;
    sub: string;
    empty: string;
    hint: string;
    /** Each resolves to false when the change didn't go through (the page says why). */
    onadd: (l: Omit<ServiceLine, "id">) => Promise<unknown>;
    onupdate: (l: ServiceLine, patch: Partial<ServiceLine>) => Promise<unknown>;
    onremove: (l: ServiceLine) => Promise<unknown>;
  } = $props();

  // A price or quantity that can't be saved: said here, next to the lines.
  let problem = $state("");
  // Changes save as you make them; a short "Saved" in the card head confirms each one.
  let saved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  function flashSaved() {
    saved = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved = false), 2000);
  }
  const onerror = (message: string) => (problem = message);

  let picking = $state(false);
  let search = $state("");
  let custom = $state({ name: "", billing: "monthly" as "monthly" | "once", unit: 0, qty: 1 });
  let confirm: Confirm;

  const monthly = $derived(lines.filter((l) => l.billing === "monthly").reduce((s, l) => s + l.amount, 0));
  const once = $derived(lines.filter((l) => l.billing === "once").reduce((s, l) => s + l.amount, 0));
  const byId = $derived(new Map(catalog.services.map((s) => [s.id, s])));
  const available = $derived.by(() => {
    const s = search.trim().toLowerCase();
    const have = new Set(lines.map((l) => l.service_id).filter(Boolean));
    return catalog.categories.map((c) => ({
      name: c.name,
      items: catalog.services.filter((x) => x.category_id === c.id && x.active && !have.has(x.id) && (!s || x.name.toLowerCase().includes(s))),
    })).filter((g) => g.items.length);
  });

  const nextSort = () => (lines.length ? Math.max(...lines.map((l) => l.sort)) + 10 : 0);
  const perDevice = (s: ServiceRow) => s.unit === "dev" || s.unit === "devonce";
  /** Starting price for a catalog service: list price x devices for per-device services. */
  const suggest = (s: ServiceRow) => ({ unit: s.price, qty: perDevice(s) ? Math.max(1, devices) : 1 });
  const cents = (n: number) => Math.round(n * 100) / 100;
  const qtyOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100000;

  async function addFromCatalog(sid: string) {
    const s = byId.get(sid)!;
    const { unit, qty } = suggest(s);
    await onadd({
      service_id: s.id, name: s.name, billing: s.unit === "dev" || s.unit === "mo" ? "monthly" : "once",
      unit_amount: unit, quantity: qty, amount: cents(unit * qty), notes: null, sort: nextSort(),
    });
  }
  async function addCustom(e: SubmitEvent) {
    e.preventDefault();
    if (!custom.name.trim()) return;
    const unit = Math.max(0, Number(custom.unit) || 0), qty = Math.round(Number(custom.qty) || 1);
    if (!qtyOk(qty)) return onerror("Quantity must be a whole number from 1 to 100,000.");
    await onadd({ service_id: null, name: custom.name.trim(), billing: custom.billing, unit_amount: unit, quantity: qty, amount: cents(unit * qty), notes: null, sort: nextSort() });
    custom = { name: "", billing: "monthly", unit: 0, qty: 1 };
  }
  async function updateLine(l: ServiceLine, patch: Partial<ServiceLine>, input?: HTMLInputElement) {
    if (patch.unit_amount !== undefined) {
      if (!Number.isFinite(patch.unit_amount) || patch.unit_amount < 0 || patch.unit_amount > 10000000) {
        onerror("Enter a price from 0 to 10,000,000."); if (input) input.value = String(l.unit_amount); return;
      }
      patch.unit_amount = cents(patch.unit_amount);
      if (patch.unit_amount === l.unit_amount) return;
    }
    if (patch.quantity !== undefined) {
      if (!qtyOk(patch.quantity)) { onerror("Quantity must be a whole number from 1 to 100,000."); if (input) input.value = String(l.quantity); return; }
      if (patch.quantity === l.quantity) return;
    }
    if (patch.notes !== undefined && (patch.notes ?? "") === (l.notes ?? "")) return;
    problem = "";
    if ((await onupdate(l, patch)) !== false) flashSaved();
  }
  async function removeLine(l: ServiceLine) {
    if (!(await confirm.ask({ title: `Remove ${l.name}?`, body: `${money(l.amount)}${l.billing === "monthly" ? "/mo" : " one time"} will come off this ${noun}.`, action: "Remove", danger: true }))) return;
    await onremove(l);
  }
</script>

<section class="card">
  <div class="card-head"><div><h2>Services</h2><p class="sub">{sub}</p></div><span class="saved" role="status">{#if saved}<span aria-hidden="true">✓</span> Saved{/if}</span></div>
  {#if lines.length}
    <ul class="lines">
      {#each lines as l (l.id)}
        {@const cat = l.service_id ? byId.get(l.service_id) : undefined}
        <li>
          <span class="qdot" class:mo={l.billing === "monthly"} class:once={l.billing !== "monthly"} aria-hidden="true"></span>
          <div class="nm">
            <span class="name">{l.name}{#if !l.service_id}<span class="tag">Custom</span>{/if}</span>
            <input class="note" placeholder={cat ? `List price ${unitPrice(cat)}` : "Add a note"} value={l.notes ?? ""} maxlength="500" aria-label="Note for {l.name}"
              onchange={(e) => updateLine(l, { notes: e.currentTarget.value.trim() || null })} />
          </div>
          <select class="input billing" aria-label="Billing for {l.name}" value={l.billing} onchange={(e) => updateLine(l, { billing: e.currentTarget.value as "monthly" | "once" })}>
            <option value="monthly">Monthly</option>
            <option value="once">One time</option>
          </select>
          <div class="calc">
            <label class="amount" title="Price per unit">
              <span aria-hidden="true">$</span>
              <input class="num" type="number" min="0" step="0.01" value={l.unit_amount} aria-label="Price per unit for {l.name}"
                onchange={(e) => updateLine(l, { unit_amount: e.currentTarget.valueAsNumber }, e.currentTarget)}
                onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            </label>
            <span class="times" aria-hidden="true">×</span>
            <label class="amount qty" title="Quantity (devices, seats, hours…)">
              <input class="num" type="number" min="1" max="100000" step="1" value={l.quantity} aria-label="Quantity for {l.name}"
                onchange={(e) => updateLine(l, { quantity: e.currentTarget.valueAsNumber }, e.currentTarget)}
                onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            </label>
            <span class="total num" aria-label="Line total">{money(l.amount)}</span>
          </div>
          <button class="iconbtn danger" aria-label="Remove {l.name}" title="Remove" onclick={() => removeLine(l)}>×</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{empty}</p>
  {/if}
  {#if problem}<p class="error problem" role="alert">{problem}</p>{/if}

  {#if picking}
    <div class="picker">
      <div class="phead">
        <input class="input" type="search" placeholder="Search your services" aria-label="Search services" bind:value={search} />
        <button type="button" class="btn ghost sm" onclick={() => { picking = false; search = ""; }}>Done</button>
      </div>
      {#each available as g (g.name)}
        <p class="eyebrow catname">{g.name}</p>
        <ul class="options">
          {#each g.items as s (s.id)}
            {@const sg = suggest(s)}
            <li><button type="button" onclick={() => addFromCatalog(s.id)}>
              <span>{s.name}</span>
              <span class="muted num">{sg.qty > 1 ? `${money(sg.unit)} × ${sg.qty} = ` : ""}{money(cents(sg.unit * sg.qty))}{s.unit === "dev" || s.unit === "mo" ? "/mo" : " one time"}</span>
              <span class="plus" aria-hidden="true">+</span>
            </button></li>
          {/each}
        </ul>
      {:else}
        <p class="muted none">{search ? "No matching services." : `Every service is already on this ${noun}.`}</p>
      {/each}
      <form class="customrow" onsubmit={addCustom}>
        <p class="eyebrow catname">Custom service</p>
        <div class="cr">
          <input class="input" placeholder="Name (e.g. On-site visit)" maxlength="120" bind:value={custom.name} aria-label="Custom service name" />
          <select class="input" bind:value={custom.billing} aria-label="Custom service billing"><option value="monthly">Monthly</option><option value="once">One time</option></select>
          <label class="amount"><span aria-hidden="true">$</span><input class="num" type="number" min="0" step="0.01" bind:value={custom.unit} aria-label="Custom service price per unit" /></label>
          <span class="times" aria-hidden="true">×</span>
          <label class="amount qty"><input class="num" type="number" min="1" max="100000" step="1" bind:value={custom.qty} aria-label="Custom service quantity" /></label>
          <button class="btn sm" disabled={!custom.name.trim()}>Add</button>
        </div>
      </form>
    </div>
    <p class="muted hint">{hint}</p>
  {:else}
    <button class="btn sm addbtn" onclick={() => (picking = true)}>+ Add service</button>
  {/if}

  <div class="totals">
    <div><span class="muted">Monthly</span><strong class="num">{money(monthly)}</strong></div>
    <div><span class="muted">One time</span><strong class="num">{money(once)}</strong></div>
    <div><span class="muted">Per year</span><strong class="num">{money(monthly * 12)}</strong></div>
  </div>
</section>

<Confirm bind:this={confirm} />

<style>
  .lines { list-style: none; }
  .lines li { display: grid; grid-template-columns: 16px minmax(0, 1fr) 112px auto 28px; gap: 10px; align-items: center; padding: 10px 4px; border-top: 1px solid var(--line); animation: rise 0.3s var(--ease) both; }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .name { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tag { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); border: 1px solid var(--line-2); border-radius: var(--radius-pill); padding: 1px 6px; }
  .note { border: 0; background: transparent; color: var(--muted); font-size: var(--fs-xs); padding: 2px 0; border-bottom: 1px dashed transparent; width: 100%; }
  .note:hover, .note:focus { border-bottom-color: var(--line-2); color: var(--text-2); }
  .billing { height: var(--control-sm); font-size: var(--fs-sm); padding: 0 32px 0 10px; background-position: right 10px center; }
  .calc { display: flex; align-items: center; gap: 6px; }
  .times { color: var(--muted); font-size: var(--fs-sm); }
  .total { min-width: 84px; text-align: right; font-weight: 650; }
  .qdot { justify-self: center; }
  .addbtn { margin-top: 12px; }
  .saved { font-size: var(--fs-sm); color: var(--good-text); white-space: nowrap; }
  .problem { margin-top: 10px; }
  .cr { display: grid; grid-template-columns: minmax(0, 1fr) 112px 104px auto 62px auto; gap: 8px; align-items: center; }
  .cr .amount { height: var(--control-md); }
  .cr .input { height: var(--control-md); }
  .cr select.input { padding: 0 32px 0 10px; background-position: right 10px center; }
  .hint { font-size: var(--fs-xs); margin-top: 8px; }
  @media (max-width: 640px) {
    .lines li { grid-template-columns: 16px minmax(0, 1fr) 28px; }
    .billing { grid-column: 2; }
    .calc { grid-column: 2; }
    .calc .amount:first-child { flex: 1 1 0; width: auto; min-width: 0; }
    .lines li > .iconbtn { grid-column: 3; grid-row: 1; }
    .cr { grid-template-columns: minmax(0, 1fr) auto 62px; }
    .cr .input:first-child, .cr select.input { grid-column: 1 / -1; }
  }
</style>
