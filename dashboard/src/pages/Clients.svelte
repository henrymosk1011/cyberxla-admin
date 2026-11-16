<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { tick } from "svelte";
  import db from "$db";
  import EmptyState from "../components/EmptyState.svelte";
  import Field from "../components/Field.svelte";
  import Kpi from "../components/Kpi.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import Modal from "../components/Modal.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import SortSelect from "../components/SortSelect.svelte";
  import { by, pressed, text, type Sort, type SortDir } from "../lib/sort.ts";
  import { localDay, money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { EMAIL } from "../lib/reports.ts";
  import { CLIENT_STATUSES, type Client, type ClientService, type ClientStatus } from "../lib/types.ts";

  let { clients, services }: { clients: Client[]; services: ClientService[] } = $props();

  let q = $state("");
  let filter = $state<ClientStatus | "all">("active");
  let creating = $state(false);
  let busy = $state(false);
  let formError = $state("");
  // What is wrong with each field, shown under it.
  let errors = $state<{ company?: string; email?: string }>({});
  // The form keeps what was typed if the dialog is closed by accident; Cancel and a finished client clear it.
  let form = $state(blank());

  function blank() {
    return { company: "", contact_name: "", email: "", phone: "", address: "", workstations: 0, servers: 0, started_on: localDay() };
  }
  function cancelNew() {
    creating = false;
    form = blank();
    errors = {};
    formError = "";
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
  // Column headings sort the list: the biggest monthly total first to start with.
  type ClientSort = "name" | "status" | "monthly" | "services" | "since";
  const COLUMNS: { key: ClientSort; label: string; first: SortDir; right?: boolean; hide?: "sm" }[] = [
    { key: "name", label: "Client", first: "asc" },
    { key: "status", label: "Status", first: "asc" },
    { key: "monthly", label: "Monthly", first: "desc", right: true },
    { key: "services", label: "Services", first: "desc", right: true, hide: "sm" },
    { key: "since", label: "Client since", first: "desc", right: true, hide: "sm" },
  ];
  let sort = $state<Sort<ClientSort>>({ key: "monthly", dir: "desc" });
  const sortBy = (k: ClientSort) => (sort = pressed(sort, k, COLUMNS.find((c) => c.key === k)!.first));
  const rows = $derived.by(() => {
    const name = (c: Client) => c.company ?? c.contact_name ?? "";
    const cmp: Record<ClientSort, (a: Client, b: Client) => number> = {
      name: (a, b) => text(name(a), name(b)),
      status: (a, b) => CLIENT_STATUSES.indexOf(a.status) - CLIENT_STATUSES.indexOf(b.status),
      monthly: (a, b) => (totals.get(a.id)?.monthly ?? 0) - (totals.get(b.id)?.monthly ?? 0),
      services: (a, b) => (totals.get(a.id)?.n ?? 0) - (totals.get(b.id)?.n ?? 0),
      since: (a, b) => (a.started_on ?? "").localeCompare(b.started_on ?? ""),
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    // Ties fall back to the name.
    return searched.filter((c) => filter === "all" || c.status === filter).sort(by((a, b) => sign * cmp[sort.key](a, b), (a, b) => text(name(a), name(b))));
  });
  const active = $derived(clients.filter((c) => c.status === "active"));
  const mrr = $derived(active.reduce((sum, c) => sum + (totals.get(c.id)?.monthly ?? 0), 0));

  const label = (c: Client) => c.company || c.contact_name || "Unnamed client";
  const open = (id: string) => (location.hash = `#/clients/${id}`);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    errors = {};
    if (!form.company.trim() && !form.contact_name.trim()) errors.company = "Add a company or a contact name.";
    if (form.email.trim() && !EMAIL.test(form.email.trim())) errors.email = "That doesn't look like an email address.";
    if (errors.company || errors.email) {
      await tick();
      document.getElementById(errors.company ? "n-co" : "n-em")?.focus();
      return;
    }
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

<PageHeader title="Clients">
  <input class="input search" type="search" placeholder="Search clients" aria-label="Search clients by company, contact, email or phone" bind:value={q} />
  <button class="btn primary" onclick={() => (creating = true)}><Icon name="plus" size={14} /> New client</button>
</PageHeader>

<div class="kpis rise">
  <section class="card hero"><Kpi hero label="Monthly recurring revenue" value="{money(mrr)}/mo" hint="from {active.length} active {active.length === 1 ? 'client' : 'clients'}" /></section>
  <section class="card"><Kpi label="Average per client" value={active.length ? `${money(mrr / active.length)}/mo` : "None yet"} /></section>
  <section class="card"><Kpi label="Per year" value="{money(mrr * 12)}/yr" /></section>
</div>

<div class="filters">
  <div class="seg" role="group" aria-label="Status filter">
    {#each CLIENT_STATUSES as st (st)}
      <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
    {/each}
    <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
  </div>
  <!-- Phones hide the table's headings, so sorting lives here. -->
  <div class="phonesort"><SortSelect id="client-sort" columns={COLUMNS} {sort} onchange={(s) => (sort = s)} /></div>
</div>

<section class="card flush">
  {#if rows.length}
    <table class="table cards">
      <caption class="sr-only">Clients, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
      <thead><tr>{#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}</tr></thead>
      <tbody>
        {#each rows as c (c.id)}
          {@const t = totals.get(c.id)}
          <tr class="link" onclick={() => open(c.id)}>
            <td class="c-name c-main">
              <a class="who" href="#/clients/{c.id}" onclick={(e) => e.stopPropagation()}>
                <strong>{label(c)}</strong>
                <span class="muted">{[c.company ? c.contact_name : null, c.email].filter(Boolean).join(" · ")}</span>
              </a>
            </td>
            <td class="c-status"><StatusPill status={c.status} /></td>
            <td class="r num c-mo c-strong">{money(t?.monthly ?? 0)}<span class="u">/mo</span></td>
            <td class="r num hide-sm">{t?.n ?? 0}</td>
            <td class="r muted hide-sm">{c.started_on ? shortDate(c.started_on + "T12:00:00") : "Not set"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    {#if !clients.length}
      <EmptyState title="No clients yet" text="Add one here, or convert a won lead from its page.">
        <button class="btn primary sm" onclick={() => (creating = true)}><Icon name="plus" size={14} /> New client</button>
      </EmptyState>
    {:else}
      <EmptyState title="No clients match">
        {#if q}<button class="btn sm" onclick={() => (q = "")}>Clear search</button>{/if}
        {#if filter !== "all" && searched.length}<button class="btn sm" onclick={() => (filter = "all")}>Show all clients</button>{/if}
      </EmptyState>
    {/if}
  {/if}
</section>

<Modal open={creating} title="New client" onclose={() => (creating = false)}>
  <form class="form" onsubmit={create} novalidate>
    <p class="muted hint">A company or a contact name is required. Everything else can wait.</p>
    <div class="grid2">
      <Field id="n-co" label="Company" error={errors.company}>{#snippet children(a)}<input {...a} class="input" maxlength="160" bind:value={form.company} />{/snippet}</Field>
      <Field id="n-ct" label="Contact name">{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={form.contact_name} />{/snippet}</Field>
      <Field id="n-em" label="Email" error={errors.email}>{#snippet children(a)}<input {...a} class="input" type="email" maxlength="254" bind:value={form.email} />{/snippet}</Field>
      <Field id="n-ph" label="Phone">{#snippet children(a)}<input {...a} class="input" type="tel" maxlength="40" bind:value={form.phone} />{/snippet}</Field>
      <Field id="n-ad" label="Address" wide>{#snippet children(a)}<input {...a} class="input" maxlength="300" bind:value={form.address} />{/snippet}</Field>
      <Field id="n-ws" label="Workstations">{#snippet children(a)}<input {...a} class="input num" type="number" min="0" bind:value={form.workstations} />{/snippet}</Field>
      <Field id="n-sv" label="Servers">{#snippet children(a)}<input {...a} class="input num" type="number" min="0" bind:value={form.servers} />{/snippet}</Field>
      <Field id="n-st" label="Client since">{#snippet children(a)}<input {...a} class="input" type="date" bind:value={form.started_on} />{/snippet}</Field>
    </div>
    <p class="muted hint">You'll add their services and prices on the next screen.</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={cancelNew}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Creating…" : "Create client"}</button>
    </div>
  </form>
</Modal>

<style>
  .filters { display: flex; flex-direction: column; gap: 10px; }
  .phonesort { display: none; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid2 .input { width: 100%; min-width: 0; }
  .hint { font-size: var(--fs-sm); }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 640px) {
    .phonesort { display: block; }
    .grid2 { grid-template-columns: 1fr; }
  }
</style>
