<script lang="ts">
  import StatusPill from "../components/StatusPill.svelte";
  import { ago, money, STATUS_LABEL } from "../lib/format.ts";
  import { LEAD_STATUSES, type Lead, type LeadStatus, type Quote } from "../lib/types.ts";

  let { leads, quotes, view, onstatus, stale }: {
    leads: Lead[]; quotes: Quote[]; view: "list" | "board"; stale: boolean;
    onstatus: (id: string, s: LeadStatus) => void;
  } = $props();

  let q = $state("");
  let filter = $state<LeadStatus | "all" | "open" | "archived">("open");
  let sort = $state<"recent" | "value" | "name">("recent");
  let dragging = $state<string | null>(null);
  let over = $state<LeadStatus | null>(null);

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
    return [...r].sort((a, b) =>
      sort === "value" ? b.value_monthly - a.value_monthly || b.value_one_time - a.value_one_time
      : sort === "name" ? (a.company || a.name).localeCompare(b.company || b.name)
      : b.updated_at.localeCompare(a.updated_at));
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

<header class="top">
  <div>
    <p class="eyebrow">Leads</p>
    <h1>{view === "board" ? "Board" : "All leads"}</h1>
  </div>
  <div class="tools">
    <input class="input search" type="search" placeholder="Search name, company, email, phone" aria-label="Search leads" bind:value={q} />
    <div class="seg" role="group" aria-label="View">
      <button aria-pressed={view === "list"} onclick={() => (location.hash = "#/leads")}>List</button>
      <button aria-pressed={view === "board"} onclick={() => (location.hash = "#/board")}>Board</button>
    </div>
  </div>
</header>

{#if view === "list"}
  <div class="filters">
    <div class="seg" role="group" aria-label="Status filter">
      <button aria-pressed={filter === "open"} onclick={() => (filter = "open")}>Open <span class="c">{counts.new + counts.contacted + counts.proposal}</span></button>
      {#each LEAD_STATUSES as st (st)}
        <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
      {/each}
      <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
      <button aria-pressed={filter === "archived"} onclick={() => (filter = "archived")}>Archived <span class="c">{searchedArchived.length}</span></button>
    </div>
    <label class="sort muted">Sort
      <select class="input sm" bind:value={sort}>
        <option value="recent">Recent activity</option>
        <option value="value">Monthly value</option>
        <option value="name">Name</option>
      </select>
    </label>
  </div>

  <section class="card flush" class:stale>
    {#if rows.length}
      <div class="scroll">
        <table class="table">
          <thead>
            <tr><th>Lead</th><th>Status</th><th class="r">Monthly</th><th class="r">One time</th><th class="r hide-sm">Quotes</th><th class="r hide-sm">Last activity</th></tr>
          </thead>
          <tbody>
            {#each rows as l (l.id)}
              <tr class="link" onclick={() => open(l.id)}>
                <td>
                  <a class="who" href="#/leads/{l.id}" onclick={(e) => e.stopPropagation()}>
                    <strong>{l.company || l.name}</strong>
                    <span class="muted">{l.company ? l.name + " · " : ""}{l.email}</span>
                  </a>
                </td>
                <td><StatusPill status={l.status} /></td>
                <td class="r num">{money(l.value_monthly)}</td>
                <td class="r num">{money(l.value_one_time)}</td>
                <td class="r num hide-sm">{quoteCount.get(l.id) ?? 0}</td>
                <td class="r muted hide-sm">{ago(l.updated_at)}</td>
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

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin-top: 4px; }
  .tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .search { width: min(340px, 100%); height: 38px; }
  .filters { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .filters .seg { flex-wrap: wrap; border-radius: 14px; }
  .c { color: var(--muted); font-weight: 500; margin-left: 2px; }
  .sort { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .input.sm { height: 34px; padding: 0 10px; }
  .flush { padding: 8px 8px 0; }
  .stale { opacity: 0.6; }
  .scroll { overflow-x: auto; }
  .who { display: flex; flex-direction: column; text-decoration: none; min-width: 0; }
  .who strong { font-weight: 600; }
  .who span { font-size: 13px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 720px) { .hide-sm { display: none; } }

  .board { display: grid; grid-template-columns: repeat(5, minmax(196px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 12px; align-items: start; }
  .col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; min-height: 240px; transition: border-color 0.15s, background 0.15s; }
  .col.over { border-color: var(--lime); background: color-mix(in srgb, var(--lime) 5%, var(--surface)); }
  .col > header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 4px 12px; font-size: 12px; }
  .cards { display: flex; flex-direction: column; gap: 8px; }
  .lead { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; cursor: grab; }
  .lead:hover { border-color: var(--line-2); }
  .lead.dragging { opacity: 0.4; }
  .lead a { text-decoration: none; }
  .lead strong { font-weight: 600; font-size: 14px; }
  .small { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 4px; }
  .amt { font-weight: 600; font-size: 14px; }
  .amt small { color: var(--muted); font-weight: 500; }
  .move { margin-top: 6px; background: var(--ink); border: 1px solid var(--line); border-radius: 6px; font-size: 12px; padding: 4px 6px; color: var(--text-2); }
  .drop { font-size: 13px; text-align: center; padding: 24px 8px; border: 1px dashed var(--line-2); border-radius: 10px; }
</style>
