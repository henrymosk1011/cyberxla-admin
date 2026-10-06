<script lang="ts">
  import db from "$db";
  import Modal from "../components/Modal.svelte";
  import { money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { CLIENT_STATUSES, type Client, type ClientService, type ClientStatus } from "../lib/types.ts";

  let { clients, services, stale }: { clients: Client[]; services: ClientService[]; stale: boolean } = $props();

  let q = $state("");
  let filter = $state<ClientStatus | "all">("active");
  let creating = $state(false);
  let busy = $state(false);
  let formError = $state("");
  let form = $state(blank());

  function blank() {
    return { company: "", contact_name: "", email: "", phone: "", address: "", workstations: 0, servers: 0, started_on: new Date().toISOString().slice(0, 10) };
  }

  const totals = $derived.by(() => {
    const m = new Map<string, { monthly: number; once: number; n: number }>();
    for (const s of services) {
      const t = m.get(s.client_id) ?? { monthly: 0, once: 0, n: 0 };
      if (s.billing === "monthly") t.monthly += s.amount; else t.once += s.amount;
      t.n++;
      m.set(s.client_id, t);
    }
    return m;
  });
  const searched = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return clients;
    return clients.filter((c) => [c.company, c.contact_name, c.email, c.phone].some((v) => (v ?? "").toLowerCase().includes(s)));
  });
  const counts = $derived(Object.fromEntries(CLIENT_STATUSES.map((st) => [st, searched.filter((c) => c.status === st).length])) as Record<ClientStatus, number>);
  const rows = $derived(searched.filter((c) => filter === "all" || c.status === filter)
    .sort((a, b) => (totals.get(b.id)?.monthly ?? 0) - (totals.get(a.id)?.monthly ?? 0) || (a.company ?? a.contact_name ?? "").localeCompare(b.company ?? b.contact_name ?? "")));
  const active = $derived(clients.filter((c) => c.status === "active"));
  const mrr = $derived(active.reduce((sum, c) => sum + (totals.get(c.id)?.monthly ?? 0), 0));

  const label = (c: Client) => c.company || c.contact_name || "Unnamed client";
  const open = (id: string) => (location.hash = `#/clients/${id}`);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    if (!form.company.trim() && !form.contact_name.trim()) return (formError = "Add a company or a contact name.");
    busy = true;
    try {
      const id = await db.createClient({
        company: form.company.trim() || null, contact_name: form.contact_name.trim() || null,
        email: form.email.trim().toLowerCase() || null, phone: form.phone.trim() || null, address: form.address.trim() || null,
        status: "active", started_on: form.started_on || null,
        workstations: Math.max(0, Math.round(form.workstations || 0)), servers: Math.max(0, Math.round(form.servers || 0)),
        notes: null, lead_id: null,
      });
      creating = false;
      form = blank();
      open(id);
    } catch (err) {
      formError = err instanceof Error ? err.message : "Couldn't create the client.";
    } finally {
      busy = false;
    }
  }
</script>

<header class="top">
  <div>
    <p class="eyebrow">Clients</p>
    <h1>Clients</h1>
  </div>
  <div class="tools">
    <input class="input search" type="search" placeholder="Search company, contact, email, phone" aria-label="Search clients" bind:value={q} />
    <button class="btn primary" onclick={() => { form = blank(); formError = ""; creating = true; }}>+ New client</button>
  </div>
</header>

<div class="kpis rise">
  <section class="card kpi hero"><p class="eyebrow">Monthly recurring revenue</p><p class="big num">{money(mrr)}<small>/mo</small></p><p class="muted">from {active.length} active {active.length === 1 ? "client" : "clients"}</p></section>
  <section class="card kpi"><p class="eyebrow">Average per client</p><p class="mid num">{active.length ? money(mrr / active.length) : "–"}<small>/mo</small></p></section>
  <section class="card kpi"><p class="eyebrow">Annualized</p><p class="mid num">{money(mrr * 12)}<small>/yr</small></p></section>
</div>

<div class="filters">
  <div class="seg" role="group" aria-label="Status filter">
    {#each CLIENT_STATUSES as st (st)}
      <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
    {/each}
    <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
  </div>
</div>

<section class="card flush" class:stale>
  {#if rows.length}
    <table class="table">
      <thead><tr><th>Client</th><th>Status</th><th class="r">Monthly</th><th class="r hide-sm">Services</th><th class="r hide-sm">Client since</th></tr></thead>
      <tbody>
        {#each rows as c (c.id)}
          {@const t = totals.get(c.id)}
          <tr class="link" onclick={() => open(c.id)}>
            <td class="c-name">
              <a class="who" href="#/clients/{c.id}" onclick={(e) => e.stopPropagation()}>
                <strong>{label(c)}</strong>
                <span class="muted">{[c.company ? c.contact_name : null, c.email].filter(Boolean).join(" · ")}</span>
              </a>
            </td>
            <td class="c-status"><span class="cstatus st-{c.status}"><i aria-hidden="true"></i>{STATUS_LABEL[c.status]}</span></td>
            <td class="r num c-mo">{money(t?.monthly ?? 0)}<span class="u">/mo</span></td>
            <td class="r num hide-sm">{t?.n ?? 0}</td>
            <td class="r muted hide-sm">{c.started_on ? shortDate(c.started_on + "T12:00:00") : "–"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="empty">{clients.length ? "No clients match." : "No clients yet. Add one, or convert a won lead from its page."}</p>
  {/if}
</section>

<Modal open={creating} title="New client" onclose={() => (creating = false)}>
  <form class="form" onsubmit={create}>
    <div class="grid2">
      <div class="field"><label for="n-co">Company</label><input id="n-co" class="input" maxlength="160" bind:value={form.company} /></div>
      <div class="field"><label for="n-ct">Contact name</label><input id="n-ct" class="input" maxlength="120" bind:value={form.contact_name} /></div>
      <div class="field"><label for="n-em">Email</label><input id="n-em" class="input" type="email" maxlength="254" bind:value={form.email} /></div>
      <div class="field"><label for="n-ph">Phone</label><input id="n-ph" class="input" type="tel" maxlength="40" bind:value={form.phone} /></div>
      <div class="field span2"><label for="n-ad">Address</label><input id="n-ad" class="input" maxlength="300" bind:value={form.address} /></div>
      <div class="field"><label for="n-ws">Workstations</label><input id="n-ws" class="input num" type="number" min="0" bind:value={form.workstations} /></div>
      <div class="field"><label for="n-sv">Servers</label><input id="n-sv" class="input num" type="number" min="0" bind:value={form.servers} /></div>
      <div class="field"><label for="n-st">Client since</label><input id="n-st" class="input" type="date" bind:value={form.started_on} /></div>
    </div>
    <p class="muted hint">You'll add their services and prices on the next screen.</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => (creating = false)}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Creating…" : "Create client"}</button>
    </div>
  </form>
</Modal>

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin-top: 4px; }
  .tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .search { width: min(320px, 100%); height: 38px; }
  .kpis { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .kpi { display: flex; flex-direction: column; gap: 6px; justify-content: flex-end; }
  .kpi.hero { background: linear-gradient(160deg, rgba(214, 255, 63, 0.08), transparent 55%), var(--surface); }
  .big { font-size: 44px; font-weight: 650; letter-spacing: -0.04em; color: var(--lime); line-height: 1.05; }
  .mid { font-size: 28px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; }
  .big small, .mid small { font-size: 0.45em; color: var(--muted); font-weight: 500; letter-spacing: 0; }
  .kpi .muted { font-size: 13px; }
  .filters { margin-bottom: 16px; }
  .c { color: var(--muted); font-weight: 500; margin-left: 2px; }
  .flush { padding: 8px 8px 0; }
  .stale { opacity: 0.6; }
  .who { display: flex; flex-direction: column; text-decoration: none; min-width: 0; }
  .who strong { font-weight: 600; }
  .who span { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
  .cstatus { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--text-2); }
  .cstatus i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .st-active i { background: var(--good); box-shadow: 0 0 6px rgba(12, 163, 12, 0.5); }
  .st-paused i { background: var(--warning); }
  .st-former i { background: var(--st-lost); }
  .u { display: none; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid2 .field { min-width: 0; }
  .grid2 .input { width: 100%; min-width: 0; }
  .span2 { grid-column: 1 / -1; }
  .hint { font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 720px) { .hide-sm { display: none; } }
  @media (max-width: 860px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .kpi.hero { grid-column: 1 / -1; }
    .top { flex-direction: column; align-items: stretch; }
    .tools { flex-wrap: nowrap; }
    .search { flex: 1 1 0; width: 0; min-width: 0; }
    .filters .seg { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; max-width: 100%; }
    .filters .seg::-webkit-scrollbar { display: none; }
    .filters .seg button { flex: none; }
  }
  @media (max-width: 640px) {
    .grid2 { grid-template-columns: 1fr; }
    .flush { padding: 4px; }
    .table thead { display: none; }
    .table, .table tbody { display: block; }
    .table tbody tr.link { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 6px 12px; padding: 14px 12px; border-bottom: 1px solid var(--line); border-radius: 10px; }
    .table tbody tr.link:last-child { border-bottom: 0; }
    .table td { display: block; padding: 0; border: 0; }
    .table td.hide-sm { display: none; }
    .c-name { grid-column: 1 / -1; }
    .who span { max-width: none; }
    .c-mo { font-weight: 600; }
    .u { display: inline; margin-left: 3px; color: var(--muted); font-weight: 500; font-size: 0.85em; }
  }
</style>
