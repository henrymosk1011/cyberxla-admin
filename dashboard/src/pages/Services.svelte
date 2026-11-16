<script lang="ts">
  import db from "$db";
  import Field from "../components/Field.svelte";
  import Modal from "../components/Modal.svelte";
  import Menu from "../components/Menu.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import Confirm from "../components/Confirm.svelte";
  import { flip } from "svelte/animate";
  import { ms } from "../lib/motion.ts";
  import { tick } from "svelte";
  import { catalog } from "../lib/store.svelte.ts";
  import { slugify, UNIT_OPTIONS, UNIT_LABEL, unitPrice } from "../lib/catalog.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { RATE_TIERS, type PackageRow, type ServiceCategory, type ServiceRow } from "../lib/types.ts";

  let q = $state("");
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
  // What is wrong with each field, shown under it.
  let errors = $state<{ name?: string; category?: string; price?: string }>({});
  // The form as it was opened, to tell whether closing would lose anything.
  let opened = $state("");
  const svcDirty = $derived(svcOpen && JSON.stringify(svc) !== opened);
  const catDirty = $derived(catOpen && JSON.stringify(cat) !== opened);

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
  /** Run a change and reload the catalog; a failure is said in a message that shows wherever you are on the page. */
  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
    } catch (e) {
      toast.error(messageOf(e, "That didn't go through. Try again."));
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
    opened = JSON.stringify(svc);
    svcNew = true;
    formError = "";
    errors = {};
    svcOpen = true;
  }
  function editService(s: ServiceRow) {
    svc = { ...s };
    opened = JSON.stringify(svc);
    svcNew = false;
    formError = "";
    errors = {};
    svcOpen = true;
  }
  async function saveService(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    errors = {};
    if (!svc.name.trim()) errors.name = "Give the service a name.";
    if (!svc.category_id) errors.category = "Pick a category.";
    if (!Number.isFinite(svc.price) || svc.price < 0) errors.price = "Enter a price of 0 or more.";
    if (errors.name || errors.category || errors.price) {
      await tick();
      document.getElementById(errors.name ? "s-name" : errors.category ? "s-cat" : "s-price")?.focus();
      return;
    }
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

  // ---- Homepage packages ----
  let packages = $state<PackageRow[]>([]);
  let pkgSaved = $state("");
  let pkgTimer: ReturnType<typeof setTimeout> | undefined;
  const loadPackages = () => db.packages().then((p) => (packages = p)).catch((e) => toast.error(`Couldn't load the homepage packages. ${messageOf(e, "Try again.")}`));
  loadPackages();
  async function saveRate(p: PackageRow, i: number, input: HTMLInputElement) {
    const v = Math.round(input.valueAsNumber * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > 10000) {
      toast.error("Enter a package rate from 0 to 10,000.");
      input.value = String(p.rates[i]);
      return;
    }
    if (v === p.rates[i]) return;
    const rates = p.rates.map((x, k) => (k === i ? v : x));
    try {
      await db.savePackageRates(p.id, rates);
      p.rates = rates;
      pkgSaved = `${p.id}:${i}`;
      clearTimeout(pkgTimer);
      pkgTimer = setTimeout(() => (pkgSaved = ""), 1600);
    } catch (e) {
      toast.error(messageOf(e, "Couldn't save the rate."));
      input.value = String(p.rates[i]);
    }
    await loadPackages();
  }
  const rateText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  // ---- Inline price ----
  let savedId = $state("");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  async function savePrice(s: ServiceRow, input: HTMLInputElement) {
    const v = Math.round(input.valueAsNumber * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > 1000000) {
      toast.error("Enter a price from 0 to 1,000,000.");
      input.value = String(s.price);
      return;
    }
    if (v === s.price) return;
    try {
      await db.saveService({ ...s, price: v }, false);
      s.price = v;
      savedId = s.id;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (savedId = ""), 1600);
    } catch (e) {
      toast.error(messageOf(e, "Couldn't save the price."));
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
    opened = JSON.stringify(cat);
    catNew = true;
    formError = "";
    errors = {};
    catOpen = true;
  }
  function editCategory(c: ServiceCategory) {
    cat = { ...c };
    opened = JSON.stringify(cat);
    catNew = false;
    formError = "";
    errors = {};
    catOpen = true;
  }
  async function saveCategory(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    errors = {};
    if (!cat.name.trim()) {
      errors.name = "Give the category a name.";
      await tick();
      document.getElementById("c-name")?.focus();
      return;
    }
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
      toast.error(`${c.name} still has ${n} service${n === 1 ? "" : "s"}. Move or delete them first.`);
      return;
    }
    if (!(await confirm.ask({ title: `Delete ${c.name}?`, body: "This empty category will be removed.", action: "Delete", danger: true }))) return;
    await run(() => db.deleteCategory(c.id));
  }

  const money = (n: number) => "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
</script>

<PageHeader title="Services" sub={`${counts.live} live on your website${counts.total > counts.live ? ` · ${counts.total - counts.live} hidden` : ""}. Changes show on the quote builder right away.`}>
  <input class="input search" type="search" placeholder="Search services" aria-label="Search services" bind:value={q} />
  <button class="btn" onclick={newCategory}>+ Category</button>
  <button class="btn primary" onclick={() => newService()}>+ Service</button>
</PageHeader>

<svelte:window onpointermove={onMove} onpointerup={endDrag} onpointercancel={endDrag} />

{#if !q && packages.length}
  <section class="card pkgs">
    <div class="pkgs-head">
      <h2>Homepage packages</h2>
      <p class="muted">Price per device per month by volume. The first tier is the "from" price on the homepage cards; the calculator uses all four. Servers are billed at 2.5×.</p>
    </div>
    <div class="pkg-grid">
      {#each packages as p (p.id)}
        <div class="pkg" class:feat={p.id === "secure"}>
          <p class="pkg-name">{p.name} <span class="muted">from ${rateText(p.rates[0] ?? 0)}</span></p>
          {#each RATE_TIERS as t, i (t)}
            <div class="tier">
              <span class="muted">{t}</span>
              <label class="amount" title="Click to change">
                <span aria-hidden="true">$</span>
                <input class="num" type="number" min="0" max="10000" step="0.01" value={p.rates[i]} aria-label="{p.name} rate for {t} devices"
                  onchange={(e) => saveRate(p, i, e.currentTarget)}
                  onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = String(p.rates[i]); e.currentTarget.blur(); } }} />
              </label>
              <span class="ok" class:show={pkgSaved === `${p.id}:${i}`}>{pkgSaved === `${p.id}:${i}` ? "✓" : ""}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
    <p class="muted pkg-note">On Build Your Quote, the package buttons add Patching, EDR and 24/7 MDR at their own prices below, so keep those in step if you change a package.</p>
  </section>
{/if}

{#if !q && groups.length}<p class="tip muted">Drag <span class="tipgrip" aria-hidden="true">⠿</span> to reorder services and categories, or move a service to another category. Click a price to change it.</p>{/if}

<div class="cats" class:busy bind:this={cats} class:dragging={!!drag} class:catdrag={drag?.kind === "cat"}>
  {#each groups as g (g.cat.id)}
    <section class="card cat" data-cat={g.cat.id} class:placeholder={drag?.kind === "cat" && drag.id === g.cat.id} animate:flip={{ duration: ms(220) }}>
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
          <button class="btn sm" onclick={() => editCategory(g.cat)}>Edit<span class="sr-only"> {g.cat.name}</span></button>
          <Menu label="More actions for {g.cat.name}" items={[
            { label: "Delete category", danger: true, disabled: g.all.length > 0, hint: g.all.length ? `Move or delete its ${g.all.length === 1 ? "service" : `${g.all.length} services`} first.` : "", onselect: () => deleteCategory(g.cat, g.all.length) },
          ]} />
        </div>
      </div>

      <ul class="svcs" class:searching={!!q}>
        {#each g.shown as s (s.id)}
          <li class:hidden={!s.active} data-id={s.id} class:placeholder={drag?.kind === "svc" && drag.id === s.id} animate:flip={{ duration: ms(200) }}>
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
              <button class="btn sm" onclick={() => editService(s)}>Edit<span class="sr-only"> {s.name}</span></button>
              <Menu label="More actions for {s.name}" items={[
                { label: s.active ? "Hide from the website" : "Show on the website", disabled: s.locked && s.active, hint: s.locked && s.active ? "Package services stay visible." : "", onselect: () => toggleActive(s) },
                { label: "Delete service", danger: true, disabled: s.locked, hint: s.locked ? "Package services can't be deleted." : "", onselect: () => deleteService(s) },
              ]} />
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

<Modal open={svcOpen} title={svcNew ? "New service" : "Edit service"} onclose={() => (svcOpen = false)} persistent={svcDirty} wide>
  <form class="form" onsubmit={saveService} novalidate>
    <div class="grid2">
      <Field id="s-name" label="Name" required wide error={errors.name}>{#snippet children(a)}<input {...a} class="input" maxlength="80" bind:value={svc.name} />{/snippet}</Field>
      <Field id="s-cat" label="Category" required error={errors.category}>
        {#snippet children(a)}
          <select {...a} class="input" bind:value={svc.category_id}>
            {#each catalog.categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field id="s-unit" label="Billing">
        {#snippet children(a)}
          <select {...a} class="input" bind:value={svc.unit}>
            {#each UNIT_OPTIONS as u (u.value)}<option value={u.value}>{u.label}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field id="s-price" label="Price ($)" required error={errors.price}>{#snippet children(a)}<input {...a} class="input num" type="number" min="0" max="1000000" step="0.01" bind:value={svc.price} />{/snippet}</Field>
      <div class="checks">
        <label><input type="checkbox" bind:checked={svc.price_from} /> Show as "from" (starting price)</label>
        <label><input type="checkbox" bind:checked={svc.in_packages} /> "In packages" badge</label>
        <label title={svc.locked ? "Package services stay visible" : ""}><input type="checkbox" bind:checked={svc.active} disabled={svc.locked} /> Visible on website</label>
      </div>
      <Field id="s-desc" label="Description" wide hint="{svc.description.length} of 400 characters">{#snippet children(a)}<textarea {...a} class="input" rows="3" maxlength="400" bind:value={svc.description}></textarea>{/snippet}</Field>
    </div>
    <p class="muted hint"><span class="req" aria-hidden="true">*</span> Required.</p>

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

<Modal open={catOpen} title={catNew ? "New category" : "Edit category"} onclose={() => (catOpen = false)} persistent={catDirty}>
  <form class="form" onsubmit={saveCategory} novalidate>
    <Field id="c-name" label="Name" required error={errors.name}>{#snippet children(a)}<input {...a} class="input" maxlength="80" bind:value={cat.name} />{/snippet}</Field>
    <Field id="c-blurb" label="Short description" hint="{cat.blurb.length} of 300 characters">{#snippet children(a)}<textarea {...a} class="input" rows="2" maxlength="300" bind:value={cat.blurb}></textarea>{/snippet}</Field>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => (catOpen = false)}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Saving…" : catNew ? "Add category" : "Save changes"}</button>
    </div>
  </form>
</Modal>

<Confirm bind:this={confirm} />

<style>
  .cats { display: flex; flex-direction: column; gap: 16px; transition: opacity 0.2s; }
  .cats.busy { opacity: 0.7; }
  .cat-head { display: flex; align-items: flex-start; gap: 8px 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .cat-head .grip { margin-left: -6px; }
  .cat-title { flex: 1 1 200px; min-width: 0; }
  .cat-title h2 { font-size: var(--fs-lg); letter-spacing: -0.02em; }
  .cat-title p { font-size: var(--fs-sm); margin-top: 2px; }
  .count { font-size: var(--fs-sm); font-weight: 500; margin-left: 4px; }
  .acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .pkgs { margin-bottom: 22px; }
  .pkgs-head h2 { font-size: var(--fs-lg); letter-spacing: -0.02em; }
  .pkgs-head p { font-size: var(--fs-sm); margin-top: 2px; max-width: 760px; }
  .pkg-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
  .pkg { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .pkg.feat { border-color: rgba(214, 255, 63, 0.45); }
  .pkg-name { font-weight: 650; margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
  .pkg-name .muted { font-weight: 500; font-size: var(--fs-sm); }
  .tier { display: grid; grid-template-columns: minmax(0, 1fr) 104px 12px; gap: 8px; align-items: center; font-size: var(--fs-sm); }
  .pkg-note { font-size: var(--fs-xs); margin-top: 10px; }
  @media (max-width: 860px) { .pkg-grid { grid-template-columns: 1fr; } }
  .tip { font-size: var(--fs-sm); margin: -8px 0 14px; }
  .tipgrip { color: var(--text-2); }
  .dragging, .dragging * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
  .catdrag .svcs, .catdrag .add, .catdrag .cat-title p { display: none; }
  .catdrag .cat-head { margin-bottom: 0; }
  .cat.placeholder, .svcs li.placeholder { outline: 1.5px dashed var(--line-2); outline-offset: -1.5px; background: rgba(214, 255, 63, 0.04); }
  .cat.placeholder > *, .svcs li.placeholder > * { visibility: hidden; }
  .svcs li.placeholder { border-radius: var(--radius-md); border-top-color: transparent; }
  .lifted { position: fixed; z-index: 50; pointer-events: none; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--lime); box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45), 0 0 0 4px var(--lime-tint); transform: rotate(-1deg) scale(1.02); animation: lift 0.18s var(--ease) both; }
  .lifted strong { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .lifted .muted { font-size: var(--fs-sm); white-space: nowrap; margin-left: auto; }
  .lifted.gcat strong { font-size: var(--fs-lg); letter-spacing: -0.02em; }
  .lifted .g { color: var(--lime); cursor: grabbing; }
  @keyframes lift { from { transform: scale(1); box-shadow: none; } }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .svcs { list-style: none; }
  .svcs li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 14px; align-items: center; padding: 12px 4px; border-top: 1px solid var(--line); animation: rise 0.35s var(--ease) both; }
  .svcs.searching li { grid-template-columns: minmax(0, 1fr) auto auto; }
  .dragging .svcs li { animation: none; }
  .svcs li > .grip { margin-left: -4px; }
  /* A hidden service is marked by its Hidden badge and a quieter name, not by fading text below readable contrast. */
  .svcs li.hidden .name { color: var(--text-2); font-weight: 500; }
  .svcs li.hidden .price .amount { opacity: 0.75; }
  .name { font-weight: 600; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .desc { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .price { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: var(--fs-sm); }
  .unit { min-width: 92px; }
  .ok { width: 12px; color: var(--good-text); font-weight: 700; opacity: 0; transition: opacity 0.2s; }
  .ok.show { opacity: 1; }
  .badge { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: var(--radius-pill); }
  .badge.inc { background: var(--lime); color: var(--on-lime); }
  .badge.off { background: var(--surface-3); color: var(--text-2); }
  .badge.lock { border: 1px solid var(--line-2); color: var(--text-2); }
  .empty-row { padding: 14px 4px; border-top: 1px solid var(--line); font-size: var(--fs-md); }
  .add { margin-top: 8px; }

  .form { display: flex; flex-direction: column; gap: 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .form :global(.input) { width: 100%; min-width: 0; }
  .hint { font-size: var(--fs-sm); }
  .req { color: var(--lime); font-weight: 700; }
  .checks { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: var(--fs-md); color: var(--text-2); }
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
  }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
</style>
