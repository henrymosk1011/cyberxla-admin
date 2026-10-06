<script lang="ts">
  import Kpi from "../components/Kpi.svelte";
  import ColumnChart from "../components/ColumnChart.svelte";
  import BarList from "../components/BarList.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import { kpis, stages, topServices, weekly } from "../lib/stats.ts";
  import { ago, money, moneyCompact, num, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import type { Lead, Quote } from "../lib/types.ts";

  let { leads, quotes, stale }: { leads: Lead[]; quotes: Quote[]; stale: boolean } = $props();

  const RANGES = [
    { weeks: 4, label: "4 weeks" },
    { weeks: 12, label: "12 weeks" },
    { weeks: 26, label: "6 months" },
    { weeks: 52, label: "12 months" },
  ];
  let weeks = $state(12);
  let tableView = $state(false);

  const k = $derived(kpis(leads, quotes, weeks));
  const wk = $derived(weekly(quotes, weeks));
  const st = $derived(stages(leads));
  const svc = $derived(topServices(quotes, weeks));
  const leadById = $derived(new Map(leads.map((l) => [l.id, l])));
  const latest = $derived(quotes.slice(0, 6));
  const rangeLabel = $derived(RANGES.find((r) => r.weeks === weeks)!.label);
</script>

<header class="top">
  <div>
    <p class="eyebrow">Overview</p>
    <h1>Pipeline</h1>
  </div>
  <div class="seg" role="group" aria-label="Time range">
    {#each RANGES as r (r.weeks)}
      <button aria-pressed={weeks === r.weeks} onclick={() => (weeks = r.weeks)}>{r.label}</button>
    {/each}
  </div>
</header>

<div class="grid" class:stale>
  <section class="card hero">
    <Kpi hero label="Open pipeline" value="{money(k.openMonthly)}/mo" hint="{num(k.openCount)} open {k.openCount === 1 ? 'lead' : 'leads'} · {money(k.openOneTime)} one time" />
  </section>
  <section class="card"><Kpi label="New leads" value={num(k.newLeads)} delta={k.newLeads - k.newLeadsPrev} deltaLabel="vs prior" hint="last {rangeLabel}" /></section>
  <section class="card"><Kpi label="Quotes received" value={num(k.quotes)} delta={k.quotes - k.quotesPrev} deltaLabel="vs prior" spark={wk.map((w) => w.count)} /></section>
  <section class="card"><Kpi label="Win rate" value={k.winRate === null ? "–" : Math.round(k.winRate * 100) + "%"} hint="{moneyCompact(k.wonMonthly)}/mo won in range" /></section>
  <section class="card"><Kpi label="Average quote" value={k.avgMonthly === null ? "–" : money(k.avgMonthly) + "/mo"} hint="monthly, in range" /></section>

  <section class="card wide">
    <div class="card-head">
      <div><h2>Quotes per week</h2><p class="sub">Last {rangeLabel}</p></div>
      <div class="seg" role="group" aria-label="View">
        <button aria-pressed={!tableView} onclick={() => (tableView = false)}>Chart</button>
        <button aria-pressed={tableView} onclick={() => (tableView = true)}>Table</button>
      </div>
    </div>
    {#if tableView}
      <div class="scroll">
        <table class="table">
          <thead><tr><th>Week of</th><th class="r">Quotes</th><th class="r">Monthly quoted</th><th class="r">One time quoted</th></tr></thead>
          <tbody>
            {#each [...wk].reverse() as w (w.start.getTime())}
              <tr><td>{shortDate(w.start)}</td><td class="r num">{w.count}</td><td class="r num">{money(w.monthly)}</td><td class="r num">{money(w.oneTime)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <ColumnChart
        label="Quotes per week"
        integer
        data={wk.map((w) => ({ label: shortDate(w.start), value: w.count, detail: `${money(w.monthly)}/mo quoted` }))}
      />
    {/if}
  </section>

  <section class="card side">
    <div class="card-head"><div><h2>Pipeline by stage</h2><p class="sub">All leads, monthly value</p></div></div>
    <BarList
      label="Leads by stage"
      rows={st.map((s) => ({ key: s.status, label: `${STATUS_LABEL[s.status]} · ${s.count}`, value: s.monthly, display: moneyCompact(s.monthly) + "/mo", detail: `${s.count} leads, ${money(s.oneTime)} one time` }))}
    />
    <a class="more" href="#/board">Open board →</a>
  </section>

  <section class="card half">
    <div class="card-head"><div><h2>Most requested services</h2><p class="sub">Share of quotes, last {rangeLabel}</p></div></div>
    {#if svc.length}
      <BarList label="Most requested services" rows={svc.map((s) => ({ key: s.id, label: s.name, value: s.count, display: `${s.count} · ${Math.round(s.share * 100)}%` }))} />
    {:else}
      <p class="empty">No quotes in this range yet.</p>
    {/if}
  </section>

  <section class="card half">
    <div class="card-head"><div><h2>Latest quotes</h2></div><a class="more" href="#/leads">All leads →</a></div>
    {#if latest.length}
      <ul class="latest">
        {#each latest as q (q.id)}
          {@const l = leadById.get(q.lead_id)}
          <li>
            <a href="#/leads/{q.lead_id}">
              <span class="who"><strong>{l?.company || l?.name || "Unknown"}</strong><span class="muted">{l?.name} · {ago(q.created_at)}</span></span>
              <span class="amt num">{money(q.monthly_total)}<small>/mo</small></span>
              {#if l}<StatusPill status={l.status} />{/if}
            </a>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">Quotes from the website will appear here.</p>
    {/if}
  </section>
</div>

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; transition: opacity 0.2s; }
  .grid.stale { opacity: 0.6; }
  .hero { grid-column: span 2; display: flex; flex-direction: column; justify-content: flex-end; background: linear-gradient(160deg, rgba(214,255,63,0.08), transparent 55%), var(--surface); }
  .wide { grid-column: span 4; }
  .side { grid-column: span 2; display: flex; flex-direction: column; }
  .half { grid-column: span 3; }
  .more { margin-top: auto; padding-top: 16px; font-size: 13px; font-weight: 600; color: var(--lime); text-decoration: none; }
  .card-head .more { margin: 0; padding: 0; }
  .scroll { overflow-x: auto; max-height: 240px; }
  .latest { list-style: none; }
  .latest a { display: grid; grid-template-columns: 1fr auto 110px; align-items: center; gap: 12px; padding: 10px 8px; margin: 0 -8px; border-radius: 10px; text-decoration: none; }
  .latest a:hover { background: var(--surface-2); }
  .latest li + li a { border-top: 1px solid var(--line); border-radius: 0; }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who span { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { font-weight: 600; }
  .amt small { color: var(--muted); font-weight: 500; }
  @media (max-width: 1180px) {
    .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .hero { grid-column: span 4; }
    .wide, .half { grid-column: span 4; }
    .side { grid-column: span 4; }
  }
  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .hero, .wide, .half, .side { grid-column: span 2; }
    .latest a { grid-template-columns: 1fr auto; }
    .latest :global(.pill) { display: none; }
  }
</style>
