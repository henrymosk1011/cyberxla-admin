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
  import { totalsBy, valueLabel } from "../lib/lines.ts";
  import { clientLabel, leadLabel, ownerOptions, parseOwner } from "../lib/projects.ts";
  import { OPEN_PROJECT_STATUSES, PROJECT_STATUSES, type Client, type Lead, type Project, type ProjectService, type ProjectStatus, type ProposalRow } from "../lib/types.ts";

  let { projects, lines, clients, leads, proposals = [] }: { projects: Project[]; lines: ProjectService[]; clients: Client[]; leads: Lead[]; proposals?: ProposalRow[] } = $props();

  let q = $state("");
  let filter = $state<ProjectStatus | "open" | "all">("open");
  let creating = $state(false);
  let busy = $state(false);
  let formError = $state("");
  // What is wrong with each field, shown under it.
  let errors = $state<{ name?: string; owner?: string }>({});
  // The form keeps what was typed if the dialog is closed by accident; Cancel and a finished project clear it.
  let form = $state(blank());

  function blank() {
    return { name: "", owner: "", status: "potential" as ProjectStatus, due_on: "" };
  }
  function cancelNew() {
    creating = false;
    form = blank();
    errors = {};
    formError = "";
  }
  const day = localDay;

  const owners = $derived(new Map<string, { kind: string; label: string }>([
    ...clients.map((c) => [c.id, { kind: "Client", label: clientLabel(c) }] as const),
    ...leads.map((l) => [l.id, { kind: "Lead", label: leadLabel(l) }] as const),
  ]));
  const ownerOf = (p: Project) => owners.get((p.client_id ?? p.lead_id)!);
  const choices = $derived(ownerOptions(clients, leads));
  const totals = $derived(totalsBy(lines, (l) => l.project_id));
  const isOpen = (p: Project) => OPEN_PROJECT_STATUSES.includes(p.status);
  // The quote each project was made from, if any.
  const quoteById = $derived(new Map(proposals.map((q) => [q.id, q])));
  const quoteOf = (p: Project) => (p.proposal_id ? quoteById.get(p.proposal_id) : undefined);

  const searched = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return projects;
    return projects.filter((p) => [p.name, ownerOf(p)?.label ?? ""].some((v) => v.toLowerCase().includes(s)));
  });
  const counts = $derived(Object.fromEntries(PROJECT_STATUSES.map((st) => [st, searched.filter((p) => p.status === st).length])) as Record<ProjectStatus, number>);
  // Column headings sort the list: soonest due first to start with.
  type ProjectSort = "name" | "status" | "quote" | "value" | "due";
  const COLUMNS: { key: ProjectSort; label: string; first: SortDir; right?: boolean; hide?: "sm" }[] = [
    { key: "name", label: "Project", first: "asc" },
    { key: "status", label: "Status", first: "asc" },
    { key: "quote", label: "Quote", first: "desc", hide: "sm" },
    { key: "value", label: "Value", first: "desc", right: true },
    { key: "due", label: "Due", first: "asc", right: true, hide: "sm" },
  ];
  let sort = $state<Sort<ProjectSort>>({ key: "due", dir: "asc" });
  const sortBy = (k: ProjectSort) => (sort = pressed(sort, k, COLUMNS.find((c) => c.key === k)!.first));
  const rows = $derived.by(() => {
    // Value: the one time total plus a year of the monthly total.
    const worth = (p: Project) => { const t = totals.get(p.id); return (t?.once ?? 0) + (t?.monthly ?? 0) * 12; };
    const cmp: Record<ProjectSort, (a: Project, b: Project) => number> = {
      name: (a, b) => text(a.name, b.name),
      status: (a, b) => PROJECT_STATUSES.indexOf(a.status) - PROJECT_STATUSES.indexOf(b.status),
      quote: (a, b) => (quoteOf(a)?.number ?? 0) - (quoteOf(b)?.number ?? 0),
      value: (a, b) => worth(a) - worth(b),
      due: (a, b) => (a.due_on ?? "").localeCompare(b.due_on ?? ""),
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return searched
      .filter((p) => filter === "all" || (filter === "open" ? isOpen(p) : p.status === filter))
      // By due date, projects without one come last either way. Ties fall back to the latest change.
      .sort(by((a, b) => (sort.key === "due" ? Number(!a.due_on) - Number(!b.due_on) : 0), (a, b) => sign * cmp[sort.key](a, b), (a, b) => b.updated_at.localeCompare(a.updated_at)));
  });

  const today = day();
  const sum = (ps: Project[]) => ps.reduce((t, p) => {
    const x = totals.get(p.id);
    return { once: t.once + (x?.once ?? 0), monthly: t.monthly + (x?.monthly ?? 0), n: t.n + 1 };
  }, { once: 0, monthly: 0, n: 0 });
  const pipeline = $derived(sum(projects.filter((p) => p.status === "potential" || p.status === "proposed")));
  const working = $derived(sum(projects.filter((p) => p.status === "in_progress")));
  const dueSoon = $derived(projects.filter((p) => isOpen(p) && p.due_on && p.due_on <= day(14)));
  const overdue = $derived(dueSoon.filter((p) => p.due_on! < today).length);

  const open = (id: string) => (location.hash = `#/projects/${id}`);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    formError = "";
    errors = {};
    if (!form.name.trim()) errors.name = "Give the project a name.";
    const owner = parseOwner(form.owner);
    if (!owner) errors.owner = "Pick the client or lead it's for.";
    if (!owner || errors.name) {
      await tick();
      document.getElementById(errors.name ? "np-name" : "np-for")?.focus();
      return;
    }
    busy = true;
    try {
      const id = await db.createProject({ ...owner, name: form.name.trim(), status: form.status, due_on: form.due_on || null, notes: null });
      creating = false;
      form = blank();
      open(id);
    } catch (err) {
      formError = err instanceof Error ? err.message : "Couldn't create the project.";
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Projects">
  <input class="input search" type="search" placeholder="Search projects" aria-label="Search projects by name, client or lead" bind:value={q} />
  <button class="btn primary" onclick={() => (creating = true)}><Icon name="plus" size={14} /> New project</button>
</PageHeader>

<div class="kpis rise">
  <section class="card hero"><Kpi hero label="Project pipeline" value={money(pipeline.once)} hint="one time{pipeline.monthly ? `, plus ${money(pipeline.monthly)}/mo` : ''} · {pipeline.n} potential and proposed" /></section>
  <section class="card"><Kpi label="In progress" value={String(working.n)} hint={working.n ? valueLabel(working) : "Nothing underway"} /></section>
  <section class="card"><Kpi label="Due in 2 weeks" value={String(dueSoon.length)} hint={overdue ? `${overdue} overdue` : "None overdue"} hintTone={overdue ? "bad" : undefined} /></section>
</div>

<div class="filters">
  <div class="seg" role="group" aria-label="Status filter">
    <button aria-pressed={filter === "open"} onclick={() => (filter = "open")}>Open <span class="c">{searched.filter(isOpen).length}</span></button>
    {#each PROJECT_STATUSES as st (st)}
      <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
    {/each}
    <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
  </div>
  <!-- Phones hide the table's headings, so sorting lives here. -->
  <div class="phonesort"><SortSelect id="project-sort" columns={COLUMNS} {sort} onchange={(s) => (sort = s)} /></div>
</div>

<section class="card flush">
  {#if rows.length}
    <table class="table cards">
      <caption class="sr-only">Projects, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
      <thead><tr>{#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}</tr></thead>
      <tbody>
        {#each rows as p (p.id)}
          {@const o = ownerOf(p)}
          {@const late = isOpen(p) && !!p.due_on && p.due_on < today}
          {@const fq = quoteOf(p)}
          <tr class="link" onclick={() => open(p.id)}>
            <td class="p-name c-main">
              <a class="who" href="#/projects/{p.id}" onclick={(e) => e.stopPropagation()}>
                <strong>{p.name}</strong>
                <span class="muted">{o ? `${o.kind} · ${o.label}` : ""}</span>
              </a>
            </td>
            <td class="p-status"><StatusPill status={p.status} /></td>
            <td class="hide-sm">{#if fq}<a class="qlink" href="#/quotes/{fq.id}" onclick={(e) => e.stopPropagation()}>Q{fq.number}</a>{/if}</td>
            <td class="r num p-val c-strong">{valueLabel(totals.get(p.id))}</td>
            <td class="r hide-sm" class:late class:muted={!late}>{p.due_on ? shortDate(p.due_on + "T12:00:00") : "No date"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    {#if !projects.length}
      <EmptyState title="No projects yet" text="Start one here, or from a lead's or client's page.">
        <button class="btn primary sm" onclick={() => (creating = true)}><Icon name="plus" size={14} /> New project</button>
      </EmptyState>
    {:else}
      <EmptyState title="No projects match">
        {#if q}<button class="btn sm" onclick={() => (q = "")}>Clear search</button>{/if}
        {#if filter !== "all" && searched.length}<button class="btn sm" onclick={() => (filter = "all")}>Show all projects</button>{/if}
      </EmptyState>
    {/if}
  {/if}
</section>

<Modal open={creating} title="New project" onclose={() => (creating = false)}>
  <form class="form" onsubmit={create} novalidate>
    <Field id="np-name" label="Project name" required error={errors.name}>{#snippet children(a)}<input {...a} class="input" maxlength="120" placeholder="e.g. Office network refresh" bind:value={form.name} />{/snippet}</Field>
    <Field id="np-for" label="For" required error={errors.owner}>
      {#snippet children(a)}
        <select {...a} class="input" bind:value={form.owner}>
          <option value="" disabled>Pick a client or lead</option>
          {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
          {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
        </select>
      {/snippet}
    </Field>
    <div class="grid2">
      <Field id="np-st" label="Status">
        {#snippet children(a)}
          <select {...a} class="input" bind:value={form.status}>
            {#each PROJECT_STATUSES as st (st)}<option value={st}>{STATUS_LABEL[st]}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field id="np-due" label="Due date">{#snippet children(a)}<input {...a} class="input" type="date" bind:value={form.due_on} />{/snippet}</Field>
    </div>
    <p class="muted hint"><span class="req" aria-hidden="true">*</span> Required.</p>
    <p class="muted hint">You'll add services, notes and credentials on the next screen.</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={cancelNew}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
    </div>
  </form>
</Modal>

<style>
  .late { color: var(--critical); }
  .filters { display: flex; flex-direction: column; gap: 10px; }
  .phonesort { display: none; }
  .p-val { white-space: nowrap; }
  .qlink { font-weight: 600; font-variant-numeric: tabular-nums; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .form .input { width: 100%; min-width: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: var(--fs-sm); }
  .req { color: var(--lime); font-weight: 700; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 640px) {
    .phonesort { display: block; }
    .grid2 { grid-template-columns: 1fr; }
  }
</style>
