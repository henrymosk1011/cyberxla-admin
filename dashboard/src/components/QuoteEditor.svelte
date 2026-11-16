<script lang="ts">
  import Icon from "./Icon.svelte";
  import { untrack } from "svelte";
  import { priceQuote, unitPrice } from "../lib/catalog.ts";
  import { catalog } from "../lib/store.svelte.ts";
  import { money } from "../lib/format.ts";
  import type { Quote } from "../lib/types.ts";

  let { quote, onsave, oncancel }: {
    quote: Quote;
    onsave: (ids: string[], workstations: number, servers: number) => Promise<void>;
    oncancel: () => void;
  } = $props();

  // The draft is a snapshot of the quote as it was when editing started.
  const start = untrack(() => ({ ids: quote.items.map((i) => i.id), ws: quote.workstations, sv: quote.servers }));
  const byId = $derived(new Map(catalog.services.map((s) => [s.id, s])));
  // Services that no longer exist in the catalog can't be re-priced, so they drop out.
  let ids = $state<string[]>(untrack(() => start.ids.filter((id) => catalog.services.some((s) => s.id === id))));
  let ws = $state(start.ws);
  let sv = $state(start.sv);
  let picking = $state(false);
  let search = $state("");
  let saving = $state(false);
  let error = $state("");

  const priced = $derived(priceQuote(catalog.services, ids, ws, sv));
  const original = start.ids;
  const added = $derived(ids.filter((id) => !original.includes(id)));
  const removed = $derived(original.filter((id) => !ids.includes(id)));
  const devicesChanged = $derived(ws !== start.ws || sv !== start.sv);
  const dirty = $derived(added.length > 0 || removed.length > 0 || devicesChanged);

  const available = $derived.by(() => {
    const s = search.trim().toLowerCase();
    return catalog.categories.map((c) => ({
      name: c.name,
      ids: catalog.services
        .filter((x) => x.category_id === c.id && x.active && !ids.includes(x.id) && (!s || x.name.toLowerCase().includes(s) || c.name.toLowerCase().includes(s)))
        .map((x) => x.id),
    })).filter((c) => c.ids.length);
  });

  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(v) ? v : 0)));
  function add(id: string) {
    ids = [...ids, id];
  }
  function remove(id: string) {
    ids = ids.filter((x) => x !== id);
  }
  async function save() {
    saving = true;
    error = "";
    try {
      await onsave(ids, ws, sv);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't save the quote.";
    } finally {
      saving = false;
    }
  }
  function focusOnMount(el: HTMLInputElement) {
    el.focus();
  }
</script>

<div class="editor">
  <div class="devices">
    {#each [{ label: "Workstations", max: 5000, get: () => ws, set: (v: number) => (ws = v) }, { label: "Servers", max: 500, get: () => sv, set: (v: number) => (sv = v) }] as d (d.label)}
      <div class="dev">
        <span class="eyebrow">{d.label}</span>
        <div class="stepper">
          <button type="button" aria-label="Fewer {d.label.toLowerCase()}" onclick={() => d.set(clamp(d.get() - 1, d.max))}>−</button>
          <input type="number" min="0" max={d.max} inputmode="numeric" aria-label={d.label} value={d.get()}
            oninput={(e) => d.set(clamp(e.currentTarget.valueAsNumber, d.max))} />
          <button type="button" aria-label="More {d.label.toLowerCase()}" onclick={() => d.set(clamp(d.get() + 1, d.max))}>+</button>
        </div>
      </div>
    {/each}
    <p class="hint muted">Per-device prices count servers at 2.5×.</p>
  </div>

  <ul class="items">
    {#each priced.items as it (it.id)}
      <li class:new={added.includes(it.id)}>
        <span class="qdot" class:mo={it.kind === "monthly"} class:once={it.kind !== "monthly"} aria-hidden="true"></span>
        <span class="name"><span class="nm">{it.name}{#if added.includes(it.id)}<span class="tag">New</span>{/if}</span><small>{unitPrice(byId.get(it.id))}</small></span>
        <span class="price num">{it.from ? "from " : ""}{money(it.cost)}<small>{it.kind === "monthly" ? "/mo" : "one time"}</small></span>
        <button type="button" class="iconbtn danger" aria-label="Remove {it.name}" title="Remove" onclick={() => remove(it.id)} disabled={ids.length === 1}><Icon name="close" /></button>
      </li>
    {/each}
  </ul>
  {#if removed.length}
    <p class="removed muted">Removing: {removed.map((id) => byId.get(id)?.name ?? quote.items.find((i) => i.id === id)?.name ?? id).join(", ")}</p>
  {/if}

  {#if picking}
    <div class="picker">
      <div class="phead">
        <input class="input" type="search" placeholder="Search services" aria-label="Search services" bind:value={search} use:focusOnMount />
        <button type="button" class="btn ghost sm" onclick={() => { picking = false; search = ""; }}>Done</button>
      </div>
      {#each available as cat (cat.name)}
        <p class="eyebrow catname">{cat.name}</p>
        <ul class="options">
          {#each cat.ids as id (id)}
            <li>
              <button type="button" onclick={() => add(id)}>
                <span>{byId.get(id)?.name}</span>
                <span class="muted num">{unitPrice(byId.get(id))}</span>
                <span class="plus" aria-hidden="true">+</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted none">{search ? "No matching services." : "Every service is already on this quote."}</p>
      {/each}
    </div>
  {:else}
    <button type="button" class="btn sm addbtn" onclick={() => (picking = true)}><Icon name="plus" size={14} /> Add service</button>
  {/if}

  <div class="foot">
    <div class="totals">
      <div><span class="muted">Monthly</span><strong class="num">{money(priced.monthly_total)}</strong>{#if priced.monthly_minimum_applied}<span class="muted small">monthly minimum applied</span>{/if}</div>
      <div><span class="muted">One time</span><strong class="num">{money(priced.one_time_total)}</strong></div>
    </div>
    <div class="actions">
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="button" class="btn ghost" onclick={oncancel} disabled={saving}>Cancel</button>
      <button type="button" class="btn primary" onclick={save} disabled={!dirty || saving || !ids.length}>{saving ? "Saving…" : "Save changes"}</button>
    </div>
  </div>
</div>

<style>
  .editor { display: flex; flex-direction: column; gap: 14px; animation: rise 0.35s var(--ease) both; }
  .devices { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 20px; padding: 14px; border-radius: var(--radius-md); background: var(--ink); border: 1px solid var(--line); }
  .dev { display: flex; flex-direction: column; gap: 6px; }
  .stepper { display: flex; align-items: center; border: 1px solid var(--line-2); border-radius: var(--radius-md); overflow: hidden; }
  /* The number field has no outline of its own; the whole stepper lights up instead. */
  .stepper:has(input:focus-visible) { border-color: var(--lime); box-shadow: 0 0 0 1px var(--lime); }
  .stepper button:focus-visible { outline-offset: -2px; }
  .stepper button { width: 34px; height: var(--control-sm); border: 0; background: var(--surface-2); font-size: var(--fs-base); transition: background 0.15s; }
  .stepper button:hover { background: var(--lime); color: var(--on-lime); }
  .stepper input { width: 64px; height: var(--control-sm); border: 0; background: transparent; text-align: center; font-variant-numeric: tabular-nums; outline: none; -moz-appearance: textfield; appearance: textfield; }
  .stepper input::-webkit-inner-spin-button, .stepper input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .hint { font-size: var(--fs-xs); margin-left: auto; }
  .items { list-style: none; display: flex; flex-direction: column; }
  .items li { display: grid; grid-template-columns: 16px 1fr auto 28px; align-items: center; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--line); animation: rise 0.3s var(--ease) both; }
  .items li.new { background: linear-gradient(90deg, rgba(214, 255, 63, 0.06), transparent 60%); }
  .name { display: flex; flex-direction: column; min-width: 0; }
  .name small, .price small { font-size: var(--fs-xs); color: var(--muted); font-weight: 400; }
  .price { text-align: right; font-weight: 600; display: flex; flex-direction: column; }
  .nm { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px; }
  .tag { display: inline-block; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--lime); }
  .qdot { justify-self: center; }
  .removed { font-size: var(--fs-sm); }
  .addbtn { align-self: flex-start; }
  .picker { margin-top: 0; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--line-2); }
  /* Here the totals sit in the editor's own footer, so no rule or space of their own. */
  .totals { padding: 0; margin: 0; border: 0; }
  .small { font-size: var(--fs-xs); }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .actions .error { width: 100%; text-align: right; }
</style>
