<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { tick, untrack } from "svelte";
  import db from "$db";
  import EmptyState from "../components/EmptyState.svelte";
  import Field from "../components/Field.svelte";
  import Kpi from "../components/Kpi.svelte";
  import Menu from "../components/Menu.svelte";
  import Modal from "../components/Modal.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import QuotesNav from "../components/QuotesNav.svelte";
  import QuotePill from "../components/QuotePill.svelte";
  import SortTh from "../components/SortTh.svelte";
  import SortSelect from "../components/SortSelect.svelte";
  import { by, pressed, text, type Sort, type SortDir } from "../lib/sort.ts";
  import { localDay, shortDate } from "../lib/format.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { ownerOptions, parseOwner } from "../lib/projects.ts";
  import { PROPOSAL_STATUS_LABEL, clientLink, ownerOf, quoteNo, quoteStats, quoteValue, valueText } from "../lib/quotes.ts";
  import { blankDoc, usd } from "../../../supabase/functions/_shared/proposal.ts";
  import { emailStatus } from "../lib/email.ts";
  import { PROPOSAL_STATUSES, type Client, type Lead, type ProposalRow, type ProposalStatus, type ProposalTemplate } from "../lib/types.ts";

  let { proposals, clients, leads, onchanged, newFor = "" }: {
    proposals: ProposalRow[]; clients: Client[]; leads: Lead[]; onchanged: () => void;
    /** "lead:<id>" or "client:<id>" from a lead's or client's New quote button: opens the dialog for them. */
    newFor?: string;
  } = $props();

  let q = $state("");
  let filter = $state<ProposalStatus | "open" | "all" | "archived">("all");
  const OPEN: ProposalStatus[] = ["sent", "viewed", "changes_requested"];

  const live = $derived(proposals.filter((p) => (filter === "archived" ? !!p.archived_at : !p.archived_at)));
  const searched = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return live;
    return live.filter((p) => [quoteNo(p), p.title, ownerOf(p, clients, leads)?.label ?? "", p.recipient_name, p.recipient_email ?? ""].some((v) => v.toLowerCase().includes(s)));
  });
  const counts = $derived(Object.fromEntries(PROPOSAL_STATUSES.map((st) => [st, searched.filter((p) => p.status === st).length])) as Record<ProposalStatus, number>);

  type Key = "number" | "client" | "title" | "total" | "status" | "sent" | "viewed" | "valid";
  const COLUMNS: { key: Key; label: string; first: SortDir; right?: boolean; hide?: "sm" | "md" }[] = [
    { key: "number", label: "Number", first: "desc" },
    { key: "client", label: "Client", first: "asc" },
    { key: "title", label: "Title", first: "asc", hide: "md" },
    { key: "total", label: "Total", first: "desc", right: true },
    { key: "status", label: "Status", first: "asc" },
    { key: "sent", label: "Sent", first: "desc", hide: "sm" },
    { key: "viewed", label: "Last viewed", first: "desc", hide: "md" },
    { key: "valid", label: "Valid until", first: "asc", hide: "sm" },
  ];
  let sort = $state<Sort<Key>>({ key: "number", dir: "desc" });
  // Until email is set up, a draft's quick action is Publish, not Send.
  let emailReady = $state<boolean | null>(null);
  $effect(() => { let gone = false; emailStatus().then((r) => { if (!gone) emailReady = r; }); return () => { gone = true; }; });
  const go = (p: ProposalRow, act: "send" | "publish") => () => (location.hash = `#/quotes/${p.id}?${act}=1`);
  function golive(p: ProposalRow) {
    if (p.status === "draft" || p.status === "scheduled" || p.revising) {
      const pub = { label: p.revising ? "Publish revision" : "Publish", onselect: go(p, "publish") };
      return emailReady ? [pub, { label: p.revising ? "Send revision" : p.status === "scheduled" ? "Send now" : "Send", onselect: go(p, "send") }] : [pub];
    }
    return [{ label: p.link_only ? "Email it to the client" : "Email it again", onselect: go(p, "send") }];
  }
  const sortBy = (k: Key) => (sort = pressed(sort, k, COLUMNS.find((c) => c.key === k)!.first));
  const rows = $derived.by(() => {
    const v = (p: ProposalRow) => { const x = quoteValue(p); return x.once + x.monthly * 12; };
    const cmp: Record<Key, (a: ProposalRow, b: ProposalRow) => number> = {
      number: (a, b) => a.number - b.number,
      client: (a, b) => text(ownerOf(a, clients, leads)?.label ?? "", ownerOf(b, clients, leads)?.label ?? ""),
      title: (a, b) => text(a.title, b.title),
      total: (a, b) => v(a) - v(b),
      status: (a, b) => PROPOSAL_STATUSES.indexOf(a.status) - PROPOSAL_STATUSES.indexOf(b.status),
      sent: (a, b) => (a.last_sent_at ?? "").localeCompare(b.last_sent_at ?? ""),
      viewed: (a, b) => (a.last_viewed_at ?? "").localeCompare(b.last_viewed_at ?? ""),
      valid: (a, b) => a.valid_until.localeCompare(b.valid_until),
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return searched
      .filter((p) => filter === "all" || filter === "archived" || (filter === "open" ? OPEN.includes(p.status) : p.status === filter))
      .sort(by((a, b) => sign * cmp[sort.key](a, b), (a, b) => b.number - a.number));
  });
  const stats = $derived(quoteStats(proposals));
  const today = localDay();

  async function copy(p: ProposalRow) {
    try { await navigator.clipboard.writeText(clientLink(p.token)); toast.success(p.version ? `${quoteNo(p)} link copied.` : `${quoteNo(p)} link copied. It works once the quote is sent.`); }
    catch { toast.error("Couldn't copy. Your browser blocked the clipboard."); }
  }
  async function duplicate(p: ProposalRow) {
    try {
      const id = await db.proposalRpc("proposal_duplicate", { p_id: p.id });
      onchanged();
      location.hash = `#/quotes/${id}`;
    } catch (e) {
      toast.error(messageOf(e, "Couldn't duplicate it."));
    }
  }
  const open = (id: string) => (location.hash = `#/quotes/${id}`);

  // New quote
  let creating = $state(false);
  let busy = $state(false);
  let formError = $state("");
  let errors = $state<{ owner?: string; title?: string; name?: string; email?: string }>({});
  let templates = $state<ProposalTemplate[]>([]);
  let form = $state(blank());
  function blank() { return { template: "", owner: "", title: "", lead: { name: "", company: "", email: "" } }; }
  const choices = $derived(ownerOptions(clients, leads));
  async function startNew() {
    creating = true;
    try { templates = await db.templates(); } catch { templates = []; }
    if (!form.template && templates[0]) { form.template = templates[0].id; form.title = templates[0].title; }
  }
  function pickTemplate(id: string) {
    form.template = id;
    const t = templates.find((x) => x.id === id);
    if (t && (!form.title || templates.some((x) => x.title === form.title))) form.title = t.title;
  }
  // From a lead's or client's page: open New quote for them, once.
  $effect(() => {
    const start = untrack(() => newFor);
    if (!parseOwner(start)) return;
    history.replaceState(history.state, "", "#/quotes");
    untrack(() => startNew().then(() => { form.owner = start; }));
  });
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  async function create(e: SubmitEvent) {
    e.preventDefault();
    formError = ""; errors = {};
    if (!form.owner) errors.owner = "Pick who it's for.";
    if (form.owner === "new") {
      if (!form.lead.name.trim()) errors.name = "Add their name.";
      if (!EMAIL.test(form.lead.email.trim())) errors.email = "Add a valid email.";
    }
    if (!form.title.trim()) errors.title = "Give it a title.";
    const first = errors.owner ? "nq-owner" : errors.name ? "nq-lname" : errors.email ? "nq-lemail" : errors.title ? "nq-title" : "";
    if (first) { await tick(); document.getElementById(first)?.focus(); return; }
    busy = true;
    try {
      let owner = parseOwner(form.owner);
      let name = "", email: string | null = null;
      if (form.owner === "new") {
        const lid = await db.createLead({ name: form.lead.name.trim(), company: form.lead.company.trim() || null, email: form.lead.email.trim(), phone: null });
        owner = { lead_id: lid, client_id: null };
        name = form.lead.name.trim(); email = form.lead.email.trim().toLowerCase();
      } else {
        const o = ownerOf(owner!, clients, leads);
        name = o?.contact ?? ""; email = o?.email ?? null;
      }
      const t = templates.find((x) => x.id === form.template);
      const settings = await db.quoteSettings().catch(() => null);
      const days = settings?.default_valid_days ?? 30;
      const id = await db.createProposal({
        ...owner!, title: form.title.trim(), recipient_name: name, recipient_email: email, cc: [],
        prepared_on: localDay(), valid_until: localDay(days), content: t ? structuredClone(t.content) : blankDoc(), internal: t ? structuredClone(t.internal) : {}, internal_notes: null, reminders: false,
      });
      creating = false;
      form = blank();
      onchanged();
      open(id);
    } catch (err) {
      formError = messageOf(err, "Couldn't create the quote.");
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Quotes" sub="Quotes you send. Quote requests from the website are on each lead's page.">
  <input class="input search" type="search" placeholder="Search quotes" aria-label="Search quotes by number, client, title or recipient" bind:value={q} />
  <button class="btn primary" onclick={startNew}><Icon name="plus" size={14} /> New quote</button>
</PageHeader>
<QuotesNav current="quotes" />

<div class="kpis four rise">
  <section class="card hero"><Kpi hero label="Open quotes" value={usd(stats.openValue)} hint="{stats.open} sent and waiting{stats.openMonthly ? `, plus ${usd(stats.openMonthly)}/mo` : ''}" /></section>
  <section class="card"><Kpi label="Sent this month" value={String(stats.sentThisMonth)} /></section>
  <section class="card"><Kpi label="Win rate" value={stats.winRate === null ? "None yet" : `${Math.round(stats.winRate * 100)}%`} hint="accepted of decided" /></section>
  <section class="card"><Kpi label="Time to accept" value={stats.avgDaysToAccept === null ? "None yet" : `${stats.avgDaysToAccept} days`} hint="average, from sent" /></section>
</div>

<div class="filters">
  <div class="seg" role="group" aria-label="Status filter">
    <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
    <button aria-pressed={filter === "open"} onclick={() => (filter = "open")}>Open <span class="c">{searched.filter((p) => OPEN.includes(p.status)).length}</span></button>
    {#each PROPOSAL_STATUSES as st (st)}
      {#if counts[st] || filter === st}<button aria-pressed={filter === st} onclick={() => (filter = st)}>{PROPOSAL_STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>{/if}
    {/each}
    <button aria-pressed={filter === "archived"} onclick={() => (filter = "archived")}>Archived <span class="c">{proposals.filter((p) => p.archived_at).length}</span></button>
  </div>
  <div class="phonesort"><SortSelect id="quote-sort" columns={COLUMNS} {sort} onchange={(s) => (sort = s)} /></div>
</div>

<section class="card flush">
  {#if rows.length}
    <table class="table cards">
      <caption class="sr-only">Quotes, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
      <thead><tr>{#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}<th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {#each rows as p (p.id)}
          {@const o = ownerOf(p, clients, leads)}
          {@const v = quoteValue(p)}
          {@const late = ["sent", "viewed", "changes_requested"].includes(p.status) && p.valid_until < today}
          <tr class="link" onclick={() => open(p.id)}>
            <td class="num c-strong"><a class="qn" href="#/quotes/{p.id}" onclick={(e) => e.stopPropagation()}>{quoteNo(p)}</a>{#if p.revising}<span class="tag">Revising</span>{/if}</td>
            <td class="c-main"><span class="who"><strong>{o?.label ?? "Unknown"}</strong><span class="muted t2">{p.title}</span></span></td>
            <td class="hide-md">{p.title}</td>
            <td class="r num nowrap">{valueText(v)}{#if !v.accepted && p.content.tiers.length > 1}<span class="u">default tier</span>{/if}</td>
            <td><QuotePill status={p.status} linkOnly={p.link_only} /></td>
            <td class="hide-sm muted">{p.last_sent_at ? shortDate(p.last_sent_at) : p.scheduled_at ? `Scheduled ${shortDate(p.scheduled_at)}` : "Not sent"}</td>
            <td class="hide-md muted">{p.last_viewed_at ? shortDate(p.last_viewed_at) : ""}</td>
            <td class="hide-sm" class:late class:muted={!late}>{shortDate(p.valid_until + "T12:00:00")}</td>
            <td class="r acts" onclick={(e) => e.stopPropagation()}>
              <Menu label="Actions for {quoteNo(p)}" items={[
                { label: "Open", onselect: () => open(p.id) },
                ...golive(p),
                { label: "Copy client link", onselect: () => copy(p) },
                { label: "Duplicate", onselect: () => duplicate(p) },
              ]} />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if !proposals.length}
    <EmptyState title="No quotes yet" text="Start one from the Google Workspace template, or from scratch.">
      <button class="btn primary sm" onclick={startNew}><Icon name="plus" size={14} /> New quote</button>
    </EmptyState>
  {:else}
    <EmptyState title="No quotes match">
      {#if q}<button class="btn sm" onclick={() => (q = "")}>Clear search</button>{/if}
      {#if filter !== "all"}<button class="btn sm" onclick={() => (filter = "all")}>Show all quotes</button>{/if}
    </EmptyState>
  {/if}
</section>

<Modal open={creating} title="New quote" onclose={() => (creating = false)} persistent={busy}>
  <form class="form" onsubmit={create} novalidate>
    <Field id="nq-tpl" label="Start from">
      {#snippet children(a)}
        <select {...a} class="input" value={form.template} onchange={(e) => pickTemplate(e.currentTarget.value)}>
          {#each templates as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
          <option value="">A blank quote</option>
        </select>
      {/snippet}
    </Field>
    <Field id="nq-owner" label="For" required error={errors.owner}>
      {#snippet children(a)}
        <select {...a} class="input" bind:value={form.owner}>
          <option value="" disabled>Pick a client or lead</option>
          {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
          {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
          <option value="new">New lead…</option>
        </select>
      {/snippet}
    </Field>
    {#if form.owner === "new"}
      <div class="grid2">
        <Field id="nq-lname" label="Their name" required error={errors.name}>{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={form.lead.name} />{/snippet}</Field>
        <Field id="nq-lcompany" label="Company">{#snippet children(a)}<input {...a} class="input" maxlength="160" bind:value={form.lead.company} />{/snippet}</Field>
        <Field id="nq-lemail" label="Email" required wide error={errors.email}>{#snippet children(a)}<input {...a} class="input" type="email" maxlength="254" bind:value={form.lead.email} />{/snippet}</Field>
      </div>
    {/if}
    <Field id="nq-title" label="Title" required error={errors.title} hint="For example: Google Workspace migration">{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={form.title} />{/snippet}</Field>
    <p class="muted hint">It gets the next number (Q{Math.max(1000, ...proposals.map((p) => p.number)) + 1} or later) and opens in the editor.</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => { creating = false; form = blank(); }}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Creating…" : "Create quote"}</button>
    </div>
  </form>
</Modal>

<style>
  .kpis.four { grid-template-columns: 2fr 1fr 1fr 1fr; }
  @media (max-width: 860px) { .kpis.four { grid-template-columns: 1fr 1fr; } }
  .filters { display: flex; flex-direction: column; gap: 10px; }
  .phonesort { display: none; }
  .qn { color: var(--text); font-weight: 650; text-decoration: none; }
  .tag { margin-left: 6px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--warning); }
  .t2 { display: none; }
  .nowrap { white-space: nowrap; }
  .late { color: var(--critical); }
  .acts { width: 44px; }
  .table .u { display: block; font-size: var(--fs-xs); color: var(--muted); }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .form :global(.input) { width: 100%; min-width: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: var(--fs-sm); }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 1100px) { .table :global(.hide-md) { display: none; } .t2 { display: inline; } }
  @media (max-width: 640px) {
    .phonesort { display: block; }
    .grid2 { grid-template-columns: 1fr; }
    .table .u { display: inline; }
  }
</style>
