<script lang="ts">
  import db from "$db";
  import Modal from "../components/Modal.svelte";
  import Confirm from "../components/Confirm.svelte";
  import { flip } from "svelte/animate";
  import { tick } from "svelte";
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

  // ---- Inline price ----
  let savedId = $state("");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  async function savePrice(s: ServiceRow, input: HTMLInputElement) {
    const v = Math.round(input.valueAsNumber * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > 1000000) {
      error = "Enter a price from 0 to 1,000,000.";
      input.value = String(s.price);
      return;
    }
    if (v === s.price) return;
    error = "";
    try {
      await db.saveService({ ...s, price: v }, false);
      s.price = v;
      savedId = s.id;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (savedId = ""), 1600);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't save the price.";
      input.value = String(s.price);
    }
    await reload().catch(() => {});
  }

  // ---- Drag and drop (pointer events: mouse, pen and touch) ----
  type Drag = {
    kind: "svc" | "cat";
    id: string;
    fromCat: string; // services: the category it started in
    startOrder: string; // snapshot to tell whether anything moved
    x: number; y: number; // pointer, viewport coords
    ox: number; oy: number; // grab offset inside the ghost
    w: number;
    label: string; meta: string;
  };
  let drag = $state<Drag | null>(null);
  let cats: HTMLDivElement;
  let raf = 0;

  const sortedCats = () => [...catalog.categories].sort((a, b) => a.sort - b.sort);
  const svcsIn = (catId: string) => catalog.services.filter((x) => x.category_id === catId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const orderKey = () => drag?.kind === "cat"
    ? sortedCats().map((c) => c.id).join()
    : sortedCats().map((c) => c.id + ":" + svcsIn(c.id).map((x) => x.id).join()).join("|");

  /** Top of an element in page coordinates, ignoring transforms (so FLIP animations don't cause jitter). */
  function layoutTop(el: HTMLElement): number {
    let y = 0;
    for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
    return y;
  }

  async function startDrag(e: PointerEvent, kind: "svc" | "cat", id: string) {
    if (q || busy || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const box = handle.closest<HTMLElement>(kind === "svc" ? "li" : "section")!.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    const s = kind === "svc" ? catalog.services.find((x) => x.id === id)! : undefined;
    const c = kind === "cat" ? catalog.categories.find((x) => x.id === id)! : undefined;
    drag = {
      kind, id, fromCat: s?.category_id ?? "", startOrder: "",
      x: e.clientX, y: e.clientY, ox: e.clientX - box.left, oy: Math.min(e.clientY - box.top, 40), w: kind === "svc" ? box.width : Math.min(box.width, 520),
      label: s?.name ?? c!.name, meta: s ? unitPrice(s) : `${svcsIn(id).length} services`,
    };
    drag.startOrder = orderKey();
    if (kind === "cat") {
      // Cards collapse to their headers; keep the grabbed one under the pointer.
      await tick();
      const sec = cats.querySelector<HTMLElement>(`section[data-cat="${CSS.escape(id)}"]`);
      if (sec) window.scrollTo({ top: layoutTop(sec) - e.clientY + 24, behavior: "instant" });
    }
    raf = requestAnimationFrame(autoScroll);
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    place();
  }

  function autoScroll() {
    if (!drag) return;
    const edge = 90, h = window.innerHeight;
    const v = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > h - edge ? (drag.y - (h - edge)) / 4 : 0;
    if (v) { window.scrollBy(0, Math.round(v)); place(); }
    raf = requestAnimationFrame(autoScroll);
  }

  /** Move the dragged item to wherever the pointer is, updating the local order live. */
  function place() {
    if (!drag || !cats) return;
    const py = drag.y + window.scrollY;
    const sections = [...cats.querySelectorAll<HTMLElement>("section[data-cat]")];
    if (drag.kind === "cat") {
      const others = sections.filter((el) => el.dataset.cat !== drag!.id);
      const idx = others.filter((el) => layoutTop(el) + el.offsetHeight / 2 < py).length;
      const ids = others.map((el) => el.dataset.cat!);
      ids.splice(idx, 0, drag.id);
      ids.forEach((cid, i) => { const c = catalog.categories.find((x) => x.id === cid); if (c && c.sort !== i * 10) c.sort = i * 10; });
      return;
    }
    // Which category is the pointer over? The last one whose top is above it.
    let target = sections[0];
    for (const el of sections) if (layoutTop(el) <= py) target = el;
    if (!target) return;
    const catId = target.dataset.cat!;
    const rows = [...target.querySelectorAll<HTMLElement>("li[data-id]")].filter((el) => el.dataset.id !== drag!.id);
    const idx = rows.filter((el) => layoutTop(el) + el.offsetHeight / 2 < py).length;
    const ids = rows.map((el) => el.dataset.id!);
    ids.splice(idx, 0, drag.id);
    const me = catalog.services.find((x) => x.id === drag!.id)!;
    if (me.category_id !== catId) me.category_id = catId;
    ids.forEach((sid, i) => { const x = catalog.services.find((v) => v.id === sid); if (x && x.sort !== i * 10) x.sort = i * 10; });
  }

  async function endDrag() {
    if (!drag) return;
    cancelAnimationFrame(raf);
    const d = drag;
    const moved = orderKey() !== d.startOrder;
    drag = null;
    if (!moved) return;
    await persist(d.kind, d.id, d.fromCat);
  }

  async function persist(kind: "svc" | "cat", id: string, fromCat: string) {
    if (kind === "cat") return run(() => db.reorder("service_categories", sortedCats().map((c) => c.id)));
    const s = catalog.services.find((x) => x.id === id)!;
    const to = s.category_id;
    await run(async () => {
      if (to !== fromCat) await db.saveService({ ...s }, false);
      await db.reorder("services", svcsIn(to).map((x) => x.id));
    });
  }

  /** Keyboard: arrow keys on a handle move the item one step (services cross into the next category at the ends). */
  async function keyMove(e: KeyboardEvent, kind: "svc" | "cat", id: string) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (q || busy) return;
    await keyStep(e.key === "ArrowUp" ? -1 : 1, kind, id);
    await tick();
    // Moving into another category re-creates the row, so put focus back on its handle.
    cats?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(kind + ":" + id)}"]`)?.focus();
  }
  async function keyStep(dir: -1 | 1, kind: "svc" | "cat", id: string) {
    const list = sortedCats();
    if (kind === "cat") {
      const i = list.findIndex((c) => c.id === id), j = i + dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j]!, list[i]!];
      list.forEach((c, k) => (c.sort = k * 10));
      return persist("cat", id, "");
    }
    const s = catalog.services.find((x) => x.id === id)!;
    const from = s.category_id;
    const ids = svcsIn(from).map((x) => x.id);
    const i = ids.indexOf(id), j = i + dir;
    if (j >= 0 && j < ids.length) {
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    } else {
      const ci = list.findIndex((c) => c.id === from) + dir;
      const next = list[ci];
      if (!next) return;
      s.category_id = next.id;
      const dest = svcsIn(next.id).map((x) => x.id).filter((x) => x !== id);
      dir < 0 ? dest.push(id) : dest.unshift(id);
      dest.forEach((sid, k) => (catalog.services.find((x) => x.id === sid)!.sort = k * 10));
      return persist("svc", id, from);
    }
    ids.forEach((sid, k) => (catalog.services.find((x) => x.id === sid)!.sort = k * 10));
    return persist("svc", id, from);
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

<svelte:window onpointermove={onMove} onpointerup={endDrag} onpointercancel={endDrag} />

{#if !q && groups.length}<p class="tip muted">Drag <span class="tipgrip" aria-hidden="true">⠿</span> to reorder services and categories, or move a service to another category. Click a price to change it.</p>{/if}

<div class="cats" class:busy bind:this={cats} class:dragging={!!drag} class:catdrag={drag?.kind === "cat"}>
  {#each groups as g (g.cat.id)}
    <section class="card cat" data-cat={g.cat.id} class:placeholder={drag?.kind === "cat" && drag.id === g.cat.id} animate:flip={{ duration: 220 }}>
      <div class="cat-head">
        {#if !q}
          <button class="grip" data-handle="cat:{g.cat.id}" aria-label="Reorder {g.cat.name}. Drag, or use the up and down arrow keys." title="Drag to reorder"
            onpointerdown={(e) => startDrag(e, "cat", g.cat.id)} onkeydown={(e) => keyMove(e, "cat", g.cat.id)}>⠿</button>
        {/if}
        <div class="cat-title">
          <h2>{g.cat.name} <span class="muted count">{g.all.length}</span></h2>
          {#if g.cat.blurb}<p class="muted">{g.cat.blurb}</p>{/if}
        </div>
        <div class="acts">
          <button class="btn sm" onclick={() => editCategory(g.cat)}>Edit</button>
          <button class="btn sm ghost del" onclick={() => deleteCategory(g.cat, g.all.length)}>Delete</button>
        </div>
      </div>

      <ul class="svcs" class:searching={!!q}>
        {#each g.shown as s (s.id)}
          <li class:hidden={!s.active} data-id={s.id} class:placeholder={drag?.kind === "svc" && drag.id === s.id} animate:flip={{ duration: 200 }}>
            {#if !q}
              <button class="grip" data-handle="svc:{s.id}" aria-label="Reorder {s.name}. Drag, or use the up and down arrow keys." title="Drag to reorder or move to another category"
                onpointerdown={(e) => startDrag(e, "svc", s.id)} onkeydown={(e) => keyMove(e, "svc", s.id)}>⠿</button>
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
            <div class="price">
              {#if s.price_from}<span class="from muted">from</span>{/if}
              <label class="amount" title="Click to change the price">
                <span aria-hidden="true">$</span>
                <input class="num" type="number" min="0" max="1000000" step="0.01" value={s.price} aria-label="Price for {s.name}"
                  onchange={(e) => savePrice(s, e.currentTarget)}
                  onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = String(s.price); e.currentTarget.blur(); } }} />
              </label>
              <span class="unit muted">{UNIT_LABEL[s.unit]}</span>
              <span class="ok" class:show={savedId === s.id} aria-live="polite">{savedId === s.id ? "✓" : ""}</span>
            </div>
            <div class="acts">
              <button class="btn sm" onclick={() => editService(s)}>Edit</button>
              <button class="btn sm ghost" disabled={s.locked && s.active} title={s.locked ? "Package services stay visible" : ""} onclick={() => toggleActive(s)}>{s.active ? "Hide" : "Show"}</button>
              <button class="btn sm ghost del" disabled={s.locked} title={s.locked ? "Package services can't be deleted" : ""} onclick={() => deleteService(s)}>Delete</button>
            </div>
          </li>
        {:else}
          <li class="empty-row muted">{drag?.kind === "svc" ? "Drop here" : "No services in this category yet."}</li>
        {/each}
      </ul>
      {#if !q}<button class="btn ghost sm add" onclick={() => newService(g.cat.id)}>+ Add a service to {g.cat.name}</button>{/if}
    </section>
  {:else}
    <p class="empty">{q ? "No services match." : "No categories yet. Start with + Category."}</p>
  {/each}
</div>

{#if drag}
  <div class="lifted" class:gcat={drag.kind === "cat"} aria-hidden="true"
    style:left="{drag.x - drag.ox}px" style:top="{drag.y - drag.oy}px" style:width="{drag.w}px">
    <span class="grip g">⠿</span>
    <strong>{drag.label}</strong>
    <span class="muted">{drag.meta}</span>
  </div>
{/if}

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
  .cat-head { display: flex; align-items: flex-start; gap: 8px 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .cat-head .grip { margin-left: -6px; }
  .cat-title { flex: 1 1 200px; min-width: 0; }
  .cat-title h2 { font-size: 18px; letter-spacing: -0.02em; }
  .cat-title p { font-size: 13px; margin-top: 2px; }
  .count { font-size: 13px; font-weight: 500; margin-left: 4px; }
  .acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .tip { font-size: 13px; margin: -8px 0 14px; }
  .tipgrip { color: var(--text-2); }
  .grip { flex: none; width: 26px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font-size: 16px; line-height: 1; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; transition: color 0.15s, background 0.15s; }
  @media (pointer: coarse) { .grip { width: 36px; height: 40px; font-size: 18px; } }
  .grip:hover, .grip:focus-visible { color: var(--lime); background: var(--surface-2); }
  .dragging, .dragging * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
  .catdrag .svcs, .catdrag .add, .catdrag .cat-title p { display: none; }
  .catdrag .cat-head { margin-bottom: 0; }
  .cat.placeholder, .svcs li.placeholder { outline: 1.5px dashed var(--line-2); outline-offset: -1.5px; background: rgba(214, 255, 63, 0.04); }
  .cat.placeholder > *, .svcs li.placeholder > * { visibility: hidden; }
  .svcs li.placeholder { border-radius: 10px; border-top-color: transparent; }
  .lifted { position: fixed; z-index: 50; pointer-events: none; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--lime); box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45), 0 0 0 4px rgba(214, 255, 63, 0.08); transform: rotate(-1deg) scale(1.02); animation: lift 0.18s var(--ease) both; }
  .lifted strong { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .lifted .muted { font-size: 13px; white-space: nowrap; margin-left: auto; }
  .lifted.gcat strong { font-size: 18px; letter-spacing: -0.02em; }
  .lifted .g { color: var(--lime); cursor: grabbing; }
  @keyframes lift { from { transform: scale(1); box-shadow: none; } }
  .del { color: var(--critical); }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .svcs { list-style: none; }
  .svcs li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 14px; align-items: center; padding: 12px 4px; border-top: 1px solid var(--line); animation: rise 0.35s var(--ease) both; }
  .svcs.searching li { grid-template-columns: minmax(0, 1fr) auto auto; }
  .dragging .svcs li { animation: none; }
  .svcs li > .grip { margin-left: -4px; }
  .svcs li.hidden .info, .svcs li.hidden .price .amount, .svcs li.hidden .unit { opacity: 0.5; }
  .name { font-weight: 600; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .desc { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .price { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; }
  .amount { display: flex; align-items: center; gap: 3px; width: 104px; height: 32px; padding: 0 10px; border: 1px solid transparent; border-radius: 9px; background: var(--surface-2); cursor: text; transition: border-color 0.15s, background 0.15s; }
  .amount:hover { border-color: var(--line-2); }
  .amount:focus-within { border-color: var(--lime); background: var(--ink); }
  .amount span { color: var(--muted); }
  .amount input { width: 100%; min-width: 0; border: 0; background: transparent; outline: none; text-align: right; font-weight: 600; font-size: 14px; -moz-appearance: textfield; appearance: textfield; }
  .amount input::-webkit-inner-spin-button, .amount input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .unit { min-width: 92px; }
  .ok { width: 12px; color: var(--good-text); font-weight: 700; opacity: 0; transition: opacity 0.2s; }
  .ok.show { opacity: 1; }
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
    .svcs.searching li { grid-template-columns: minmax(0, 1fr); }
    .svcs li > .grip { grid-row: 1 / span 3; align-self: start; }
    .price { grid-column: 2; }
    .svcs.searching .price, .svcs.searching li > .acts { grid-column: 1; }
    .unit { min-width: 0; }
    .svcs li > .acts { grid-column: 2; }
    .desc { white-space: normal; }
    .search { flex: 1 1 100%; width: auto; }
  }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
</style>
