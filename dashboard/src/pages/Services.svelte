<script lang="ts">
  import db from "$db";
  import Modal from "../components/Modal.svelte";
  import Confirm from "../components/Confirm.svelte";
  import { catalog } from "../lib/store.svelte.ts";
  import { slugify, UNIT_OPTIONS, UNIT_LABEL, unitPrice } from "../lib/catalog.ts";
  import type { ServiceCategory, ServiceRow } from "../lib/types.ts";

  let q = $state("");
  let error = $state("");
  let busy = $state(false);
  let confirm: Confirm;

  // Editors
  let svcOpen = $state(false);
  let svcNew = $state(false);
  let svc = $state<ServiceRow>(blankService(""));
  let catOpen = $state(false);
  let catNew = $state(false);
  let cat = $state<ServiceCategory>({ id: "", name: "", blurb: "", sort: 0 });
  let formError = $state("");

  const groups = $derived.by(() => {
    const s = q.trim().toLowerCase();
    return [...catalog.categories].sort((a, b) => a.sort - b.sort).map((c) => ({
      cat: c,
      all: catalog.services.filter((x) => x.category_id === c.id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
    })).map((g) => ({
      ...g,
      shown: s ? g.all.filter((x) => (x.name + " " + x.description).toLowerCase().includes(s)) : g.all,
    })).filter((g) => !s || g.shown.length);
  });
  const counts = $derived({ total: catalog.services.length, live: catalog.services.filter((s) => s.active).length });

  async function reload() {
    [catalog.categories, catalog.services] = await Promise.all([db.categories(), db.services()]);
  }
  async function run(fn: () => Promise<void>) {
    error = "";
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    } finally {
      busy = false;
      await reload().catch(() => {});
    }
  }

  function blankService(categoryId: string): ServiceRow {
    return { id: "", category_id: categoryId, name: "", description: "", price: 0, unit: "dev", price_from: false, in_packages: false, active: true, locked: false, sort: 0 };
  }
  function newService(categoryId = catalog.categories[0]?.id ?? "") {
    svc = blankService(categoryId);
    svcNew = true;
    formError = "";
    svcOpen = true;
  }
  function editService(s: ServiceRow) {
    svc = { ...s };
    svcNew = false;
    formError = "";
    svcOpen = true;
  }
  async function saveService(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    if (!svc.name.trim()) return (formError = "Give the service a name.");
    if (!svc.category_id) return (formError = "Pick a category.");
    if (!Number.isFinite(svc.price) || svc.price < 0) return (formError = "Enter a price of 0 or more.");
    const row = { ...svc };
    if (svcNew) {
      row.id = slugify(row.name, catalog.services.map((s) => s.id));
      const siblings = catalog.services.filter((s) => s.category_id === row.category_id);
      row.sort = siblings.length ? Math.max(...siblings.map((s) => s.sort)) + 10 : 0;
    } else {
      const before = catalog.services.find((s) => s.id === row.id);
      if (before && before.category_id !== row.category_id) {
        const siblings = catalog.services.filter((s) => s.category_id === row.category_id);
        row.sort = siblings.length ? Math.max(...siblings.map((s) => s.sort)) + 10 : 0;
      }
    }
    busy = true;
    try {
      await db.saveService(row, svcNew);
      svcOpen = false;
      await reload();
    } catch (err) {
      formError = err instanceof Error ? err.message : "Couldn't save.";
    } finally {
      busy = false;
    }
  }
  async function toggleActive(s: ServiceRow) {
    await run(() => db.saveService({ ...s, active: !s.active }, false));
  }
  async function deleteService(s: ServiceRow) {
    if (!(await confirm.ask({ title: `Delete ${s.name}?`, body: "It disappears from your website's quote builder right away. Quotes and clients that already include it keep their copy. To take it off the site temporarily, hide it instead.", action: "Delete", danger: true }))) return;
    await run(() => db.deleteService(s.id));
  }
  async function move(list: { id: string }[], i: number, dir: -1 | 1, table: "services" | "service_categories") {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await run(() => db.reorder(table, ids));
  }

  function newCategory() {
    cat = { id: "", name: "", blurb: "", sort: (Math.max(-10, ...catalog.categories.map((c) => c.sort)) + 10) };
    catNew = true;
    formError = "";
    catOpen = true;
  }
  function editCategory(c: ServiceCategory) {
    cat = { ...c };
    catNew = false;
    formError = "";
    catOpen = true;
  }
  async function saveCategory(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    if (!cat.name.trim()) return (formError = "Give the category a name.");
    const row = { ...cat, id: catNew ? slugify(cat.name, catalog.categories.map((c) => c.id)) : cat.id };
    busy = true;
    try {
      await db.saveCategory(row, catNew);
      catOpen = false;
      await reload();
    } catch (err) {
      formError = err instanceof Error ? err.message : "Couldn't save.";
    } finally {
      busy = false;
    }
  }
  async function deleteCategory(c: ServiceCategory, n: number) {
    if (n) {
      error = `${c.name} still has ${n} service${n === 1 ? "" : "s"}. Move or delete them first.`;
      return;
    }
    if (!(await confirm.ask({ title: `Delete ${c.name}?`, body: "This empty category will be removed.", action: "Delete", danger: true }))) return;
    await run(() => db.deleteCategory(c.id));
  }

  const money = (n: number) => "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
</script>

<header class="top">
  <div>
    <p class="eyebrow">Catalog</p>
    <h1>Services</h1>
    <p class="sub muted">{counts.live} live on your website{counts.total > counts.live ? ` · ${counts.total - counts.live} hidden` : ""}. Changes show on the quote builder right away.</p>
  </div>
  <div class="tools">
    <input class="input search" type="search" placeholder="Search services" aria-label="Search services" bind:value={q} />
    <button class="btn" onclick={newCategory}>+ Category</button>
    <button class="btn primary" onclick={() => newService()}>+ Service</button>
  </div>
</header>

{#if error}<p class="error banner" role="alert">{error} <button class="btn ghost sm" onclick={() => (error = "")}>Dismiss</button></p>{/if}

<div class="cats" class:busy>
  {#each groups as g, gi (g.cat.id)}
    <section class="card cat">
      <div class="cat-head">
        <div class="cat-title">
          <h2>{g.cat.name} <span class="muted count">{g.all.length}</span></h2>
          {#if g.cat.blurb}<p class="muted">{g.cat.blurb}</p>{/if}
        </div>
        <div class="acts">
          {#if !q}
            <button class="icon" aria-label="Move {g.cat.name} up" disabled={gi === 0} onclick={() => move(groups.map((x) => x.cat), gi, -1, "service_categories")}>↑</button>
            <button class="icon" aria-label="Move {g.cat.name} down" disabled={gi === groups.length - 1} onclick={() => move(groups.map((x) => x.cat), gi, 1, "service_categories")}>↓</button>
          {/if}
          <button class="btn sm" onclick={() => editCategory(g.cat)}>Edit</button>
          <button class="btn sm ghost del" onclick={() => deleteCategory(g.cat, g.all.length)}>Delete</button>
        </div>
      </div>

      <ul class="svcs">
        {#each g.shown as s, i (s.id)}
          <li class:hidden={!s.active}>
            {#if !q}
              <div class="order">
                <button class="icon sm" aria-label="Move {s.name} up" disabled={i === 0} onclick={() => move(g.all, i, -1, "services")}>↑</button>
                <button class="icon sm" aria-label="Move {s.name} down" disabled={i === g.shown.length - 1} onclick={() => move(g.all, i, 1, "services")}>↓</button>
              </div>
            {/if}
            <div class="info">
              <p class="name">
                {s.name}
                {#if s.in_packages}<span class="badge inc">In packages</span>{/if}
                {#if !s.active}<span class="badge off">Hidden</span>{/if}
                {#if s.locked}<span class="badge lock" title="Used by the Essential, Secure and Shield packages on your homepage">Package service</span>{/if}
              </p>
              <p class="desc muted">{s.description}</p>
            </div>
            <p class="price num">{unitPrice(s)}</p>
            <div class="acts">
              <button class="btn sm" onclick={() => editService(s)}>Edit</button>
              <button class="btn sm ghost" disabled={s.locked && s.active} title={s.locked ? "Package services stay visible" : ""} onclick={() => toggleActive(s)}>{s.active ? "Hide" : "Show"}</button>
              <button class="btn sm ghost del" disabled={s.locked} title={s.locked ? "Package services can't be deleted" : ""} onclick={() => deleteService(s)}>Delete</button>
            </div>
          </li>
        {:else}
          <li class="empty-row muted">No services in this category yet.</li>
        {/each}
      </ul>
      {#if !q}<button class="btn ghost sm add" onclick={() => newService(g.cat.id)}>+ Add a service to {g.cat.name}</button>{/if}
    </section>
  {:else}
    <p class="empty">{q ? "No services match." : "No categories yet. Start with + Category."}</p>
  {/each}
</div>

<Modal open={svcOpen} title={svcNew ? "New service" : `Edit ${svc.name || "service"}`} onclose={() => (svcOpen = false)} wide>
  <form class="form" onsubmit={saveService}>
    <div class="grid2">
      <div class="field span2">
        <label for="s-name">Name</label>
        <input id="s-name" class="input" maxlength="80" required bind:value={svc.name} />
      </div>
      <div class="field">
        <label for="s-cat">Category</label>
        <select id="s-cat" class="input" bind:value={svc.category_id}>
          {#each catalog.categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="s-unit">Billing</label>
        <select id="s-unit" class="input" bind:value={svc.unit}>
          {#each UNIT_OPTIONS as u (u.value)}<option value={u.value}>{u.label}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="s-price">Price ($)</label>
        <input id="s-price" class="input num" type="number" min="0" max="1000000" step="0.01" required bind:value={svc.price} />
      </div>
      <div class="checks">
        <label><input type="checkbox" bind:checked={svc.price_from} /> Show as "from" (starting price)</label>
        <label><input type="checkbox" bind:checked={svc.in_packages} /> "In packages" badge</label>
        <label title={svc.locked ? "Package services stay visible" : ""}><input type="checkbox" bind:checked={svc.active} disabled={svc.locked} /> Visible on website</label>
      </div>
      <div class="field span2">
        <label for="s-desc">Description <span class="muted">{svc.description.length}/400</span></label>
        <textarea id="s-desc" class="input" rows="3" maxlength="400" bind:value={svc.description}></textarea>
      </div>
    </div>

    <div class="preview-wrap">
      <p class="eyebrow">Preview on your website</p>
      <article class="preview">
        <h3>{svc.name || "Service name"}{#if svc.in_packages}<span class="pinc">In packages</span>{/if}</h3>
        <p>{svc.description || "A short description of what's included."}</p>
        <div class="pfoot">
          <span><b>{svc.price_from ? "from " : ""}{money(Number(svc.price) || 0)}</b> <span>{UNIT_LABEL[svc.unit]}</span></span>
          <span class="padd">+ Add</span>
        </div>
      </article>
    </div>

    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => (svcOpen = false)}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Saving…" : svcNew ? "Add service" : "Save changes"}</button>
    </div>
  </form>
</Modal>

<Modal open={catOpen} title={catNew ? "New category" : `Edit ${cat.name || "category"}`} onclose={() => (catOpen = false)}>
  <form class="form" onsubmit={saveCategory}>
    <div class="field">
      <label for="c-name">Name</label>
      <input id="c-name" class="input" maxlength="80" required bind:value={cat.name} />
    </div>
    <div class="field">
      <label for="c-blurb">Short description <span class="muted">{cat.blurb.length}/300</span></label>
      <textarea id="c-blurb" class="input" rows="2" maxlength="300" bind:value={cat.blurb}></textarea>
    </div>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => (catOpen = false)}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Saving…" : catNew ? "Add category" : "Save changes"}</button>
    </div>
  </form>
</Modal>

<Confirm bind:this={confirm} />

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin-top: 4px; }
  .sub { font-size: 14px; margin-top: 6px; }
  .tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .search { width: 240px; height: 38px; }
  .banner { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .cats { display: flex; flex-direction: column; gap: 16px; transition: opacity 0.2s; }
  .cats.busy { opacity: 0.7; }
  .cat-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .cat-title h2 { font-size: 18px; letter-spacing: -0.02em; }
  .cat-title p { font-size: 13px; margin-top: 2px; }
  .count { font-size: 13px; font-weight: 500; margin-left: 4px; }
  .acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .icon { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--surface-2); color: var(--text-2); font-size: 13px; line-height: 1; transition: background 0.15s, color 0.15s; }
  .icon.sm { width: 24px; height: 22px; font-size: 11px; border-radius: 6px; }
  .icon:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
  .icon:disabled { opacity: 0.3; cursor: default; }
  .del { color: var(--critical); }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .svcs { list-style: none; }
  .svcs li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 14px; align-items: center; padding: 12px 4px; border-top: 1px solid var(--line); animation: rise 0.35s var(--ease) both; }
  .svcs li.hidden .info, .svcs li.hidden .price { opacity: 0.5; }
  .order { display: flex; flex-direction: column; gap: 2px; }
  .name { font-weight: 600; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .desc { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .price { font-weight: 600; white-space: nowrap; font-size: 14px; }
  .badge { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; }
  .badge.inc { background: var(--lime); color: var(--on-lime); }
  .badge.off { background: var(--surface-3); color: var(--muted); }
  .badge.lock { border: 1px solid var(--line-2); color: var(--text-2); }
  .empty-row { padding: 14px 4px; border-top: 1px solid var(--line); font-size: 14px; }
  .add { margin-top: 8px; }

  .form { display: flex; flex-direction: column; gap: 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid2 .field { min-width: 0; }
  .grid2 .input { width: 100%; min-width: 0; }
  .span2 { grid-column: 1 / -1; }
  .checks { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 14px; color: var(--text-2); }
  .checks label { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; }
  .checks input { accent-color: var(--lime); width: 16px; height: 16px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .preview-wrap { display: flex; flex-direction: column; gap: 8px; }
  .preview { background: #fbfaf6; color: #111315; border: 1.5px solid rgba(17, 19, 21, 0.16); border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; }
  .preview h3 { font-size: 19px; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .preview p { color: #565b60; font-size: 14px; overflow-wrap: anywhere; }
  .pinc { background: var(--lime); color: #111315; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 7px; border-radius: 6px; }
  .pfoot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  .pfoot b { font-size: 19px; }
  .pfoot span span { color: #565b60; font-size: 13px; }
  .padd { border: 1.5px solid #111315; border-radius: 999px; padding: 6px 14px; font-weight: 700; font-size: 13px; }

  @media (max-width: 760px) {
    .svcs li { grid-template-columns: auto minmax(0, 1fr); }
    .price { grid-column: 2; }
    .svcs li > .acts { grid-column: 2; }
    .desc { white-space: normal; }
    .search { flex: 1 1 100%; width: auto; }
  }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
</style>
