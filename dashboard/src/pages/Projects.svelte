<script lang="ts">
  import db from "$db";
  import Modal from "../components/Modal.svelte";
  import { money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { totalsBy, valueLabel } from "../lib/lines.ts";
  import { clientLabel, leadLabel, ownerOptions, parseOwner } from "../lib/projects.ts";
  import { OPEN_PROJECT_STATUSES, PROJECT_STATUSES, type Client, type Lead, type Project, type ProjectService, type ProjectStatus } from "../lib/types.ts";

  let { projects, lines, clients, leads, stale }: { projects: Project[]; lines: ProjectService[]; clients: Client[]; leads: Lead[]; stale: boolean } = $props();

  let q = $state("");
  let filter = $state<ProjectStatus | "open" | "all">("open");
  let creating = $state(false);
  let busy = $state(false);
  let formError = $state("");
  let form = $state(blank());

  function blank() {
    return { name: "", owner: "", status: "potential" as ProjectStatus, due_on: "" };
  }
  /** YYYY-MM-DD in local time, `days` from today. */
  function day(days = 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

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
  // Soonest due first; undated after.
  const rows = $derived(searched
    .filter((p) => filter === "all" || (filter === "open" ? isOpen(p) : p.status === filter))
    .sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || b.updated_at.localeCompare(a.updated_at)));

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
    if (!form.name.trim()) return (formError = "Give the project a name.");
    const owner = parseOwner(form.owner);
    if (!owner) return (formError = "Pick the client or lead it's for.");
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

<header class="top">
  <div>
    <p class="eyebrow">Projects</p>
    <h1>Projects</h1>
  </div>
  <div class="tools">
    <input class="input search" type="search" placeholder="Search project, client, lead" aria-label="Search projects" bind:value={q} />
    <button class="btn primary" onclick={() => { form = blank(); formError = ""; creating = true; }}>+ New project</button>
  </div>
</header>

<div class="kpis rise">
  <section class="card kpi hero">
    <p class="eyebrow">Pipeline</p>
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
</div>

<section class="card flush" class:stale>
  {#if rows.length}
    <table class="table">
      <thead><tr><th>Project</th><th>Status</th><th class="r">Value</th><th class="r hide-sm">Due</th></tr></thead>
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
  <form class="form" onsubmit={create}>
    <div class="field"><label for="np-name">Project name</label><input id="np-name" class="input" maxlength="120" placeholder="e.g. Office network refresh" bind:value={form.name} /></div>
    <div class="field">
      <label for="np-for">For</label>
      <select id="np-for" class="input" bind:value={form.owner}>
        <option value="" disabled>Pick a client or lead</option>
        {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
        {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
      </select>
    </div>
    <div class="grid2">
      <div class="field">
        <label for="np-st">Status</label>
        <select id="np-st" class="input" bind:value={form.status}>
          {#each PROJECT_STATUSES as st (st)}<option value={st}>{STATUS_LABEL[st]}</option>{/each}
        </select>
      </div>
      <div class="field"><label for="np-due">Target date</label><input id="np-due" class="input" type="date" bind:value={form.due_on} /></div>
    </div>
    <p class="muted hint">You'll add services, notes and credentials on the next screen.</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={() => (creating = false)}>Cancel</button>
      <button class="btn primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
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
  .big small { font-size: 0.4em; color: var(--muted); font-weight: 500; letter-spacing: 0; margin-left: 8px; }
  .kpi .muted { font-size: 13px; }
  .late { color: var(--critical); }
  .filters { margin-bottom: 16px; }
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
  .grid2 .field { min-width: 0; }
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
    .p-name { grid-column: 1 / -1; }
    .who span { max-width: none; }
    .p-val { font-weight: 600; }
  }
</style>
