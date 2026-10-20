<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import Credentials from "../components/Credentials.svelte";
  import ServiceLines from "../components/ServiceLines.svelte";
  import { describeCredential, describeLine, describeProject } from "../lib/activity.ts";
  import { dateTime, money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { clientLabel, leadLabel, ownerOptions, ownerValue, parseOwner } from "../lib/projects.ts";
  import { PROJECT_STATUSES, type AuditEntry, type Client, type Lead, type Project, type ProjectService, type ProjectStatus, type Quote } from "../lib/types.ts";

  let { id, version, clients, leads, quotes }: { id: string; version: number; clients: Client[]; leads: Lead[]; quotes: Quote[] } = $props();

  let project = $state<Project | null | undefined>(undefined);
  let lines = $state<ProjectService[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let error = $state("");
  let saved = $state("");
  let confirm: Confirm;
  let showHidden = $state(false);

  // Editable copies
  let details = $state({ name: "", owner: "", due_on: "" });
  let notes = $state("");

  async function load() {
    try {
      const [p, l, a] = await Promise.all([db.project(id), db.projectServices(id), db.projectActivity(id)]);
      project = p; lines = l; activity = a;
      if (p) {
        details = { name: p.name, owner: ownerValue(p), due_on: p.due_on ?? "" };
        notes = p.notes ?? "";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load this project.";
    }
  }
  $effect(() => {
    void id; void version;
    load();
  });

  const client = $derived.by(() => {
    const cid = project?.client_id;
    return cid ? clients.find((c) => c.id === cid) : undefined;
  });
  const lead = $derived.by(() => {
    const lid = project?.lead_id;
    return lid ? leads.find((l) => l.id === lid) : undefined;
  });
  const owner = $derived(client ? { kind: "Client", label: clientLabel(client), href: `#/clients/${client.id}` }
    : lead ? { kind: "Lead", label: leadLabel(lead), href: `#/leads/${lead.id}` } : null);
  // Per-device services start at the client's device count, or the lead's newest quote.
  const devices = $derived.by(() => {
    if (client) return client.workstations + client.servers;
    const q = lead ? quotes.filter((x) => x.lead_id === lead.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;
    return q ? q.workstations + q.servers : 0;
  });
  const hint = $derived(`Per-device services start at list price × ${devices} ${devices === 1 ? "device" : "devices"} (${client ? "the client's count" : "from the lead's newest quote"}). You can change the price and quantity after adding.`);
  const choices = $derived(ownerOptions(clients, leads, project ?? undefined));

  const monthly = $derived(lines.filter((l) => l.billing === "monthly").reduce((s, l) => s + l.amount, 0));
  const once = $derived(lines.filter((l) => l.billing === "once").reduce((s, l) => s + l.amount, 0));
  const detailsDirty = $derived(!!project && (details.name !== project.name || details.owner !== ownerValue(project) || details.due_on !== (project.due_on ?? "")));
  const notesDirty = $derived(!!project && notes !== (project.notes ?? ""));
  const visibleActivity = $derived(activity.filter((a) => showHidden || !a.hidden));
  const hiddenCount = $derived(activity.filter((a) => a.hidden).length);

  async function run(fn: () => Promise<void>, ok = "") {
    error = "";
    try {
      await fn();
      if (ok) { saved = ok; setTimeout(() => (saved = ""), 2000); }
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    }
    await load();
  }
  async function saveDetails(e: SubmitEvent) {
    e.preventDefault();
    if (!details.name.trim()) { error = "Give the project a name."; return; }
    const o = parseOwner(details.owner);
    if (!o) { error = "Pick the client or lead it's for."; return; }
    await run(() => db.updateProject(id, { name: details.name.trim(), ...o, due_on: details.due_on || null }), "Details saved");
  }
  const setStatus = (s: ProjectStatus) => project && project.status !== s && run(() => db.updateProject(id, { status: s }));
  const saveNotes = () => run(() => db.updateProject(id, { notes: notes.trim() || null }), "Notes saved");
  async function reloadActivity() {
    activity = await db.projectActivity(id).catch(() => activity);
  }
  async function deleteProject() {
    if (!project) return;
    if (!(await confirm.ask({ title: `Delete ${project.name}?`, body: "This permanently deletes the project with its services, notes and saved credentials.", action: "Delete permanently", danger: true }))) return;
    try {
      await db.deleteProject(id);
      location.hash = "#/projects";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't delete.";
    }
  }
  const toggleHidden = (a: AuditEntry) => run(() => db.hideActivity(a.id, !a.hidden));

  function describe(a: AuditEntry): string {
    if (a.table_name === "projects") return describeProject(a);
    if (a.table_name === "project_credentials") return describeCredential(a);
    return describeLine(a);
  }
</script>

<a class="back" href="#/projects">← All projects</a>

{#if project === undefined}
  <p class="muted">Loading…</p>
{:else if project === null}
  <p class="empty">{error || "This project doesn't exist or was deleted."}</p>
{:else}
  <header class="head">
    <div>
      <p class="eyebrow">Project{project.due_on ? ` · due ${shortDate(project.due_on + "T12:00:00")}` : ""}</p>
      <h1>{project.name}</h1>
      {#if owner}<p class="contact"><span>{owner.kind}</span><a href={owner.href}>{owner.label} →</a></p>{/if}
    </div>
    <div class="value">
      <span class="big num">{money(once)}<small>one time</small></span>
      <span class="muted num">+ {money(monthly)}/mo · {money(monthly * 12)}/yr</span>
      <button class="btn sm ghost del" onclick={deleteProject}>Delete project</button>
    </div>
  </header>

  <div class="stages" role="group" aria-label="Status">
    {#each PROJECT_STATUSES as s (s)}
      <button class="stage ps-{s}" aria-pressed={project.status === s} onclick={() => setStatus(s)}><i aria-hidden="true"></i>{STATUS_LABEL[s]}</button>
    {/each}
    {#if saved}<span class="saved">✓ {saved}</span>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="cols">
    <div class="main">
      <ServiceLines
        {lines} {devices} noun="project"
        sub="What this project covers. Click a price or quantity to change it."
        empty="No services yet. Add what this project would include below."
        {hint}
        onadd={(l) => run(() => db.addProjectService({ ...l, project_id: id }))}
        onupdate={(l, patch) => run(() => db.updateProjectService(l.id, patch), "Saved")}
        onremove={(l) => run(() => db.deleteProjectService(l.id))}
        onerror={(m) => (error = m)} />

      <section class="card">
        <div class="card-head"><div><h2>Notes</h2><p class="sub">Not encrypted. Keep passwords and keys in Credentials.</p></div></div>
        <textarea class="input" rows="6" maxlength="20000" placeholder="Scope, site details, contacts, next steps…" bind:value={notes}></textarea>
        <div class="row"><button class="btn primary sm" disabled={!notesDirty} onclick={saveNotes}>Save notes</button></div>
      </section>

      <Credentials projectId={id} onchange={reloadActivity} />
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Details</h2></div>
        <form class="form" onsubmit={saveDetails}>
          <div class="field"><label for="p-name">Name</label><input id="p-name" class="input" maxlength="120" bind:value={details.name} /></div>
          <div class="field">
            <label for="p-for">For</label>
            <select id="p-for" class="input" bind:value={details.owner}>
              {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
              {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
            </select>
          </div>
          <div class="field"><label for="p-due">Target date</label><input id="p-due" class="input" type="date" bind:value={details.due_on} /></div>
          <div class="row"><button class="btn primary sm" disabled={!detailsDirty}>Save details</button></div>
        </form>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Activity</h2>
          {#if hiddenCount}<button class="btn ghost sm" onclick={() => (showHidden = !showHidden)}>{showHidden ? "Hide" : "Show"} removed ({hiddenCount})</button>{/if}
        </div>
        <ol class="timeline">
          {#each visibleActivity as a (a.id)}
            <li class:hidden-entry={a.hidden}>
              <span class="dot" aria-hidden="true"></span>
              <div><p>{describe(a)}</p><span class="muted small">{dateTime(a.at)}{a.hidden ? " · removed" : ""}</span></div>
              <button class="x" title={a.hidden ? "Put back on the timeline" : "Remove from timeline"} aria-label={a.hidden ? "Restore this entry" : "Remove this entry from the timeline"} onclick={() => toggleHidden(a)}>{a.hidden ? "↺" : "×"}</button>
            </li>
          {:else}
            <li class="muted">No activity yet.</li>
          {/each}
        </ol>
      </section>
    </aside>
  </div>
{/if}

<Confirm bind:this={confirm} />

<style>
  .back { display: inline-block; font-size: 13px; color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 34px; letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 8px; overflow-wrap: anywhere; }
  .contact { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 14px; color: var(--text-2); }
  .contact a { color: var(--lime); text-decoration: none; overflow-wrap: anywhere; }
  .contact a:hover { text-decoration: underline; }
  .value { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .big { font-size: 34px; font-weight: 650; letter-spacing: -0.03em; color: var(--lime); }
  .big small { font-size: 15px; color: var(--muted); font-weight: 500; letter-spacing: 0; margin-left: 6px; }
  .del { color: var(--critical); margin-top: 8px; }
  .stages { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 20px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface); color: var(--text-2); font-size: 13px; font-weight: 600; transition: background 0.2s, color 0.2s, border-color 0.2s; }
  .stage:hover { background: var(--surface-2); color: var(--text); }
  .stage[aria-pressed="true"] { background: var(--surface-3); color: var(--text); border-color: var(--text-2); }
  .stage i { width: 8px; height: 8px; border-radius: 50%; }
  .ps-potential i { background: var(--st-new); } .ps-proposed i { background: var(--st-proposal); } .ps-in_progress i { background: var(--st-contacted); }
  .ps-on_hold i { background: var(--warning); } .ps-done i { background: var(--good); } .ps-cancelled i { background: var(--st-lost); }
  .saved { font-size: 13px; color: var(--good-text); animation: rise 0.3s var(--ease) both; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
  .main, .side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  textarea.input { width: 100%; }
  .row { display: flex; justify-content: flex-end; margin-top: 10px; }
  .form { display: flex; flex-direction: column; gap: 10px; }
  .form .input { height: 38px; width: 100%; min-width: 0; }
  .form .field { min-width: 0; }
  .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; border-radius: 6px; padding: 2px 6px; transition: color 0.15s, background 0.15s; }
  .x:hover { color: var(--critical); background: var(--surface-2); }
  .timeline { list-style: none; display: flex; flex-direction: column; gap: 14px; }
  .timeline li { display: flex; gap: 12px; font-size: 13px; align-items: flex-start; }
  .timeline li > div { flex: 1; min-width: 0; }
  .timeline .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--axis); flex: none; }
  .timeline li:first-child .dot { background: var(--lime); }
  .timeline .x { font-size: 16px; opacity: 0; }
  .timeline li:hover .x, .timeline .x:focus-visible { opacity: 1; }
  .timeline li.hidden-entry { opacity: 0.5; }
  .timeline li.hidden-entry .x { opacity: 1; }
  .small { font-size: 12px; }
  @media (hover: none) { .timeline .x { opacity: 1; } }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } .value { align-items: flex-start; } }
</style>
