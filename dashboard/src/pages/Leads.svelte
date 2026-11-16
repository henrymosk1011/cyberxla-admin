<script lang="ts">
  import StatusPill from "../components/StatusPill.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import SortSelect from "../components/SortSelect.svelte";
  import { by, pressed, text, type Sort, type SortDir } from "../lib/sort.ts";
  import ExportDialog from "../components/ExportDialog.svelte";
  import { ago, money, STATUS_LABEL } from "../lib/format.ts";
  import { LEAD_STATUSES, type Client, type Lead, type LeadStatus, type Quote } from "../lib/types.ts";

  let { leads, quotes, clients, view, onstatus, stale }: {
    leads: Lead[]; quotes: Quote[]; clients: Client[]; view: "list" | "board"; stale: boolean;
    onstatus: (id: string, s: LeadStatus) => void;
  } = $props();

  let q = $state("");
  let filter = $state<LeadStatus | "all" | "open" | "archived">("open");
  // Column headings sort the list: most recent activity first to start with.
  type LeadSort = "name" | "stage" | "monthly" | "once" | "quotes" | "recent";
  const COLUMNS: { key: LeadSort; label: string; first: SortDir; right?: boolean; hide?: "sm" }[] = [
    { key: "name", label: "Lead", first: "asc" },
    { key: "stage", label: "Stage", first: "asc" },
    { key: "monthly", label: "Monthly", first: "desc", right: true },
    { key: "once", label: "One time", first: "desc", right: true },
    { key: "quotes", label: "Quotes", first: "desc", right: true, hide: "sm" },
    { key: "recent", label: "Last activity", first: "desc", right: true, hide: "sm" },
  ];
  let sort = $state<Sort<LeadSort>>({ key: "recent", dir: "desc" });
  const sortBy = (k: LeadSort) => (sort = pressed(sort, k, COLUMNS.find((c) => c.key === k)!.first));
  let dragging = $state<string | null>(null);
  let over = $state<LeadStatus | null>(null);
  let exporting = $state(false);

  const quoteCount = $derived(quotes.reduce((m, x) => m.set(x.lead_id, (m.get(x.lead_id) ?? 0) + 1), new Map<string, number>()));
  const archived = $derived(leads.filter((l) => l.archived_at));
  const active = $derived(leads.filter((l) => !l.archived_at));
  const searched = $derived(search(active));
  const searchedArchived = $derived(search(archived));
  function search(list: Lead[]) {
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((l) => [l.name, l.company ?? "", l.email, l.phone ?? ""].some((v) => v.toLowerCase().includes(s)));
  }
  const counts = $derived(Object.fromEntries(LEAD_STATUSES.map((st) => [st, searched.filter((l) => l.status === st).length])) as Record<LeadStatus, number>);
  const rows = $derived.by(() => {
    const r = filter === "archived" ? searchedArchived : searched.filter((l) => filter === "all" || (filter === "open" ? ["new", "contacted", "proposal"].includes(l.status) : l.status === filter));
    const cmp: Record<LeadSort, (a: Lead, b: Lead) => number> = {
      name: (a, b) => text(a.company || a.name, b.company || b.name),
      stage: (a, b) => LEAD_STATUSES.indexOf(a.status) - LEAD_STATUSES.indexOf(b.status),
      monthly: (a, b) => a.value_monthly - b.value_monthly,
      once: (a, b) => a.value_one_time - b.value_one_time,
      quotes: (a, b) => (quoteCount.get(a.id) ?? 0) - (quoteCount.get(b.id) ?? 0),
      recent: (a, b) => a.updated_at.localeCompare(b.updated_at),
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    // Ties fall back to the most recent activity.
    return [...r].sort(by((a, b) => sign * cmp[sort.key](a, b), (a, b) => b.updated_at.localeCompare(a.updated_at)));
  });
  const columns = $derived(LEAD_STATUSES.map((st) => ({ status: st, leads: searched.filter((l) => l.status === st).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) })));

  const open = (id: string) => (location.hash = `#/leads/${id}`);
  function drop(st: LeadStatus) {
    if (dragging) {
      const l = leads.find((x) => x.id === dragging);
      if (l && l.status !== st) onstatus(l.id, st);
    }
    dragging = null;
    over = null;
  }
</script>

<PageHeader title="Leads">
  <input class="input search" type="search" placeholder="Search leads" aria-label="Search leads by name, company, email or phone" bind:value={q} />
  <div class="seg" role="group" aria-label="View">
    <button aria-pressed={view === "list"} onclick={() => (location.hash = "#/leads")}>List</button>
    <button aria-pressed={view === "board"} onclick={() => (location.hash = "#/board")}>Board</button>
  </div>
  <button class="btn export" onclick={() => (exporting = true)} disabled={!leads.length} title="Download leads as Excel or CSV">
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Export
  </button>
</PageHeader>

{#if view === "list"}
  <div class="filters">
    <div class="seg" role="group" aria-label="Stage filter">
      <button aria-pressed={filter === "open"} onclick={() => (filter = "open")}>Open <span class="c">{counts.new + counts.contacted + counts.proposal}</span></button>
      {#each LEAD_STATUSES as st (st)}
        <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
      {/each}
      <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
      <button aria-pressed={filter === "archived"} onclick={() => (filter = "archived")}>Archived <span class="c">{searchedArchived.length}</span></button>
    </div>
    <!-- Phones hide the table's headings, so sorting lives here. -->
    <div class="phonesort"><SortSelect id="lead-sort" columns={COLUMNS} {sort} onchange={(s) => (sort = s)} /></div>
  </div>

  <section class="card flush" class:stale>
    {#if rows.length}
      <div class="scroll">
        <table class="table cards">
          <caption class="sr-only">Leads, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
          <thead>
            <tr>{#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}</tr>
          </thead>
          <tbody>
            {#each rows as l (l.id)}
              <tr class="link" onclick={() => open(l.id)}>
                <td class="c-lead c-main">
                  <a class="who" href="#/leads/{l.id}" onclick={(e) => e.stopPropagation()}>
                    <strong>{l.company || l.name}</strong>
                    <span class="muted">{l.company ? l.name + " · " : ""}{l.email}</span>
                  </a>
                </td>
                <td class="c-status"><StatusPill status={l.status} /></td>
                <td class="r num c-mo c-strong">{money(l.value_monthly)}<span class="u">/mo</span></td>
                <td class="r num c-once">{money(l.value_one_time)}<span class="u"> one time</span></td>
                <td class="r num hide-sm c-quotes">{quoteCount.get(l.id) ?? 0}</td>
                <td class="r muted hide-sm c-ago">{ago(l.updated_at)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty">{filter === "archived" && !q ? "No archived leads." : leads.length ? "No leads match." : "No leads yet. Quotes from the website will show up here."}</p>
    {/if}
  </section>
{:else}
  <div class="board" class:stale>
    {#each columns as col (col.status)}
      <section
        class="col" class:over={over === col.status} aria-label="{STATUS_LABEL[col.status]} column"
        ondragover={(e) => { e.preventDefault(); over = col.status; }}
        ondragleave={() => (over = over === col.status ? null : over)}
        ondrop={(e) => { e.preventDefault(); drop(col.status); }}
      >
        <header><StatusPill status={col.status} /><span class="muted num">{col.leads.length} · {money(col.leads.reduce((s, l) => s + l.value_monthly, 0))}/mo</span></header>
        <div class="cards">
          {#each col.leads as l (l.id)}
            <article
              class="lead" draggable="true" class:dragging={dragging === l.id}
              ondragstart={(e) => { dragging = l.id; e.dataTransfer?.setData("text/plain", l.id); }}
              ondragend={() => { dragging = null; over = null; }}
            >
              <a href="#/leads/{l.id}"><strong>{l.company || l.name}</strong></a>
              <span class="muted small">{l.company ? l.name : l.email}</span>
              <div class="row">
                <span class="num amt">{money(l.value_monthly)}<small>/mo</small></span>
                <span class="muted small">{ago(l.updated_at)}</span>
              </div>
              <select class="move" aria-label="Move {l.company || l.name} to" value={l.status} onchange={(e) => onstatus(l.id, e.currentTarget.value as LeadStatus)}>
                {#each LEAD_STATUSES as st (st)}<option value={st}>{STATUS_LABEL[st]}</option>{/each}
              </select>
            </article>
          {:else}
            <p class="drop muted">Drop leads here</p>
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

<ExportDialog open={exporting} onclose={() => (exporting = false)} {leads} shown={view === "board" ? searched : rows} {quotes} {clients} />

<style>
  .export { display: inline-flex; align-items: center; gap: 7px; }
  .filters { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .filters .seg { flex-wrap: wrap; border-radius: var(--radius); }
  .phonesort { display: none; }
  .scroll { overflow-x: auto; }

  /* Tablets and phones: the filter chips swipe sideways. */
  @media (max-width: 860px) {
    .filters { flex-direction: column; align-items: stretch; }
    .filters .seg { flex-wrap: nowrap; border-radius: var(--radius-pill); scroll-snap-type: x proximity; }
    .filters .seg button { scroll-snap-align: start; }
  }

  /* Phones: each lead is a compact card (app.css); the one time value and the last activity sit on its last line. */
  @media (max-width: 640px) {
    .phonesort { display: block; }
    .c-once { grid-column: 2; grid-row: 3; font-size: var(--fs-xs); color: var(--muted); }
    .table td.c-quotes { display: none; }
    .table td.c-ago { display: block; grid-column: 1; grid-row: 3; text-align: left; font-size: var(--fs-xs); }
  }

  /* Board on smaller screens: swipe column by column, with a peek of the next. */
  @media (max-width: 1100px) {
    .board {
      grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(260px, 46%);
      scroll-snap-type: x mandatory; overscroll-behavior-x: contain; scrollbar-width: none;
      margin: 0 calc(-1 * clamp(16px, 3vw, 40px)); padding: 0 clamp(16px, 3vw, 40px) 12px;
      scroll-padding: 0 clamp(16px, 3vw, 40px);
    }
    .board::-webkit-scrollbar { display: none; }
    .col { scroll-snap-align: start; }
  }
  @media (max-width: 640px) {
    .board { grid-auto-columns: 84%; }
  }

  .board { display: grid; grid-template-columns: repeat(5, minmax(196px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 12px; align-items: start; }
  .col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; min-height: 240px; transition: border-color 0.15s, background 0.15s; }
  .col.over { border-color: var(--lime); background: color-mix(in srgb, var(--lime) 5%, var(--surface)); }
  .col > header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 4px 12px; font-size: var(--fs-xs); }
  .col > header > :last-child { white-space: nowrap; }
  .cards { display: flex; flex-direction: column; gap: 8px; }
  .lead { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 4px; cursor: grab; transition: transform 0.25s var(--ease), border-color 0.2s, box-shadow 0.25s var(--ease); animation: rise 0.4s var(--ease) both; }
  .lead:hover { border-color: var(--line-2); transform: translateY(-2px); box-shadow: var(--shadow-sm); }
  .lead.dragging { opacity: 0.4; }
  .lead a { text-decoration: none; }
  .lead strong { font-weight: 600; font-size: var(--fs-md); }
  .small { font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 4px; }
  .amt { font-weight: 600; font-size: var(--fs-md); }
  .amt small { color: var(--muted); font-weight: 500; }
  .move { margin-top: 6px; background-color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: var(--fs-xs); padding: 5px 32px 5px 8px; background-position: right 10px center; color: var(--text-2); }
  .drop { font-size: var(--fs-sm); text-align: center; padding: 24px 8px; border: 1px dashed var(--line-2); border-radius: var(--radius-md); }
</style>
