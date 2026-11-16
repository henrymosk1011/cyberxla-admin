<script lang="ts">
  import { tick } from "svelte";
  import db from "$db";
  import Field from "../components/Field.svelte";
  import Modal from "../components/Modal.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import SortSelect from "../components/SortSelect.svelte";
  import { by, pressed, text, type Sort, type SortDir } from "../lib/sort.ts";
  import { localDay, money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { totalsBy, valueLabel } from "../lib/lines.ts";
  import { clientLabel, leadLabel, ownerOptions, parseOwner } from "../lib/projects.ts";
  import { OPEN_PROJECT_STATUSES, PROJECT_STATUSES, type Client, type Lead, type Project, type ProjectService, type ProjectStatus } from "../lib/types.ts";

  let { projects, lines, clients, leads, stale }: { projects: Project[]; lines: ProjectService[]; clients: Client[]; leads: Lead[]; stale: boolean } = $props();

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

  const searched = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return projects;
    return projects.filter((p) => [p.name, ownerOf(p)?.label ?? ""].some((v) => v.toLowerCase().includes(s)));
  });
  const counts = $derived(Object.fromEntries(PROJECT_STATUSES.map((st) => [st, searched.filter((p) => p.status === st).length])) as Record<ProjectStatus, number>);
  // Column headings sort the list: soonest due first to start with.
  type ProjectSort = "name" | "status" | "value" | "due";
  const COLUMNS: { key: ProjectSort; label: string; first: SortDir; right?: boolean; hide?: "sm" }[] = [
    { key: "name", label: "Project", first: "asc" },
    { key: "status", label: "Status", first: "asc" },
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
  <button class="btn primary" onclick={() => (creating = true)}>+ New project</button>
</PageHeader>

<div class="kpis rise">
  <section class="card kpi hero">
    <p class="eyebrow">Project pipeline</p>
    <p class="big num">{money(pipeline.once)}<small>one time</small></p>
    <p class="muted">{pipeline.monthly ? `+ ${money(pipeline.monthly)}/mo · ` : ""}{pipeline.n} potential and proposed</p>
  </section>
  <section class="card kpi"><p class="eyebrow">In progress</p><p class="mid num">{working.n}</p><p class="muted">{working.n ? valueLabel(working) : "Nothing underway"}</p></section>
  <section class="card kpi"><p class="eyebrow">Due in 2 weeks</p><p class="mid num">{dueSoon.length}</p><p class="muted" class:late={overdue > 0}>{overdue ? `${overdue} overdue` : "None overdue"}</p></section>
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

<section class="card flush" class:stale>
  {#if rows.length}
    <table class="table">
      <caption class="sr-only">Projects, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
      <thead><tr>{#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}</tr></thead>
      <tbody>
        {#each rows as p (p.id)}
          {@const o = ownerOf(p)}
          {@const late = isOpen(p) && !!p.due_on && p.due_on < today}
          <tr class="link" onclick={() => open(p.id)}>
            <td class="p-name">
              <a class="who" href="#/projects/{p.id}" onclick={(e) => e.stopPropagation()}>
                <strong>{p.name}</strong>
                <span class="muted">{o ? `${o.kind} · ${o.label}` : ""}</span>
              </a>
            </td>
            <td class="p-status"><span class="pstatus ps-{p.status}"><i aria-hidden="true"></i>{STATUS_LABEL[p.status]}</span></td>
            <td class="r num p-val">{valueLabel(totals.get(p.id))}</td>
            <td class="r hide-sm" class:late class:muted={!late}>{p.due_on ? shortDate(p.due_on + "T12:00:00") : "–"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="empty">{projects.length ? "No projects match." : "No projects yet. Start one here, or from a lead's or client's page."}</p>
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
  .kpis { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .kpi { display: flex; flex-direction: column; gap: 6px; justify-content: flex-end; }
  .kpi.hero { background: linear-gradient(160deg, rgba(214, 255, 63, 0.08), transparent 55%), var(--surface); }
  .big { font-size: 44px; font-weight: 650; letter-spacing: -0.04em; color: var(--lime); line-height: 1.05; }
  .mid { font-size: 28px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; }
  .big small { font-size: 0.4em; color: var(--muted); font-weight: 500; letter-spacing: 0; margin-left: 8px; }
  .kpi .muted { font-size: 13px; }
  .late { color: var(--critical); }
  .filters { margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px; }
  .phonesort { display: none; }
  .c { color: var(--muted); font-weight: 500; margin-left: 2px; }
  .flush { padding: 8px 8px 0; }
  .stale { opacity: 0.6; }
  .who { display: flex; flex-direction: column; text-decoration: none; min-width: 0; }
  .who strong { font-weight: 600; }
  .who span { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
  .pstatus { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--text-2); white-space: nowrap; }
  .pstatus i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .ps-potential i { background: var(--st-new); } .ps-proposed i { background: var(--st-proposal); } .ps-in_progress i { background: var(--st-contacted); }
  .ps-on_hold i { background: var(--warning); } .ps-done i { background: var(--good); } .ps-cancelled i { background: var(--st-lost); }
  .p-val { white-space: nowrap; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .form .input { width: 100%; min-width: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: 13px; }
  .req { color: var(--lime); font-weight: 700; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 720px) { .hide-sm { display: none; } }
  @media (max-width: 860px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .kpi.hero { grid-column: 1 / -1; }
    .filters .seg { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; max-width: 100%; }
    .filters .seg::-webkit-scrollbar { display: none; }
    .filters .seg button { flex: none; }
  }
  @media (max-width: 640px) {
    .phonesort { display: block; }
    .grid2 { grid-template-columns: 1fr; }
    .flush { padding: 4px; }
    .table thead { display: none; }
    .table, .table tbody { display: block; }
    .table tbody tr.link { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 6px 12px; padding: 14px 12px; border-bottom: 1px solid var(--line); border-radius: 10px; }
    .table tbody tr.link:last-child { border-bottom: 0; }
    .table td { display: block; padding: 0; border: 0; }
    .table td.hide-sm { display: none; }
    .p-name { grid-column: 1 / -1; }
    .who span { max-width: none; }
    .p-val { font-weight: 600; }
  }
</style>
