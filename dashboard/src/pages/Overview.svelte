<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ColumnChart from "../components/ColumnChart.svelte";
  import BarList from "../components/BarList.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import { kpis, stages, topServices, weekly } from "../lib/stats.ts";
  import { ago, money, moneyCompact, num, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import type { Client, ClientService, Lead, Quote } from "../lib/types.ts";

  let { leads, quotes, clients = [], clientLines = [] }: { leads: Lead[]; quotes: Quote[]; clients?: Client[]; clientLines?: ClientService[] } = $props();

  const activeClients = $derived(new Set(clients.filter((c) => c.status === "active").map((c) => c.id)));
  const mrr = $derived(clientLines.filter((l) => l.billing === "monthly" && activeClients.has(l.client_id)).reduce((s, l) => s + l.amount, 0));

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

<PageHeader title="Overview">
  <div class="seg" role="group" aria-label="Time range">
    {#each RANGES as r (r.weeks)}
      <button aria-pressed={weeks === r.weeks} onclick={() => (weeks = r.weeks)}>{r.label}</button>
    {/each}
  </div>
</PageHeader>

<div class="grid rise">
  <section class="card hero">
    <a class="hero-link" href="#/clients"><Kpi hero label="Monthly recurring revenue" value="{money(mrr)}/mo" hint="{num(activeClients.size)} active {activeClients.size === 1 ? 'client' : 'clients'} · {moneyCompact(mrr * 12)}/yr" /></a>
    <div class="pipe">
      <span class="eyebrow">Open pipeline</span>
      <span class="pv num">{money(k.openMonthly)}<small>/mo</small></span>
      <span class="muted">{num(k.openCount)} open {k.openCount === 1 ? "lead" : "leads"} · {money(k.openOneTime)} one time</span>
    </div>
  </section>
  <section class="card"><Kpi label="New leads" value={num(k.newLeads)} delta={k.newLeads - k.newLeadsPrev} deltaLabel="vs prior" hint="last {rangeLabel}" /></section>
  <section class="card"><Kpi label="Quote requests" value={num(k.quotes)} delta={k.quotes - k.quotesPrev} deltaLabel="vs prior" spark={wk.map((w) => w.count)} /></section>
  <section class="card"><Kpi label="Win rate" value={k.winRate === null ? "None yet" : Math.round(k.winRate * 100) + "%"} hint="{moneyCompact(k.wonMonthly)}/mo won in range" /></section>
  <section class="card"><Kpi label="Average request" value={k.avgMonthly === null ? "None yet" : money(k.avgMonthly) + "/mo"} hint="monthly, quote requests in range" /></section>

  <section class="card wide">
    <div class="card-head">
      <div><h2>Quote requests per week</h2><p class="sub">Last {rangeLabel}</p></div>
      <div class="seg" role="group" aria-label="View">
        <button aria-pressed={!tableView} onclick={() => (tableView = false)}>Chart</button>
        <button aria-pressed={tableView} onclick={() => (tableView = true)}>Table</button>
      </div>
    </div>
    {#if tableView}
      <div class="scroll">
        <table class="table">
          <thead><tr><th>Week of</th><th class="r">Quote requests</th><th class="r">Monthly quoted</th><th class="r">One time quoted</th></tr></thead>
          <tbody>
            {#each [...wk].reverse() as w (w.start.getTime())}
              <tr><td>{shortDate(w.start)}</td><td class="r num">{w.count}</td><td class="r num">{money(w.monthly)}</td><td class="r num">{money(w.oneTime)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <ColumnChart
        label="Quote requests per week"
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
    <a class="more" href="#/board">Open board <Icon name="arrow-right" size={14} /></a>
  </section>

  <section class="card half">
    <div class="card-head"><div><h2>Most requested services</h2><p class="sub">Share of quote requests, last {rangeLabel}</p></div></div>
    {#if svc.length}
      <BarList label="Most requested services" rows={svc.map((s) => ({ key: s.id, label: s.name, value: s.count, display: `${s.count} · ${Math.round(s.share * 100)}%` }))} />
    {:else}
      <p class="empty">No quotes in this range yet.</p>
    {/if}
  </section>

  <section class="card half">
    <div class="card-head"><div><h2>Latest quote requests</h2></div><a class="more" href="#/leads">All leads <Icon name="arrow-right" size={14} /></a></div>
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
      <p class="empty">Quote requests from the website will appear here.</p>
    {/if}
  </section>
</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; transition: opacity 0.2s; }
  .hero { grid-column: span 2; display: flex; flex-direction: column; justify-content: flex-end; gap: 16px; }
  .hero-link { text-decoration: none; color: inherit; }
  .pipe { display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
  .pv { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.02em; }
  .pv small { font-size: var(--fs-sm); color: var(--muted); font-weight: 500; }
  .wide { grid-column: span 4; }
  .side { grid-column: span 2; display: flex; flex-direction: column; }
  .half { grid-column: span 3; }
  .more { margin-top: auto; padding: 16px 0 4px; font-size: var(--fs-sm); font-weight: 600; color: var(--lime); text-decoration: none; }
  .card-head .more { margin: 0; padding: 4px 0; }
  .scroll { overflow-x: auto; max-height: 240px; }
  .latest { list-style: none; }
  .latest a { display: grid; grid-template-columns: 1fr auto 110px; align-items: center; gap: 12px; padding: 10px 8px; margin: 0 -8px; border-radius: var(--radius-md); text-decoration: none; }
  .latest a:hover { background: var(--surface-2); }
  .latest li + li a { border-top: 1px solid var(--line); border-radius: 0; }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who span { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { font-weight: 600; }
  .amt small { font-size: var(--fs-xs); color: var(--muted); font-weight: 500; }
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
