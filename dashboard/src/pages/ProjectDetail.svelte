<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import Menu from "../components/Menu.svelte";
  import Credentials from "../components/Credentials.svelte";
  import ServiceLines from "../components/ServiceLines.svelte";
  import ActivityCard from "../components/ActivityCard.svelte";
  import Field from "../components/Field.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import StageButtons from "../components/StageButtons.svelte";
  import LoadState from "../components/LoadState.svelte";
  import FromQuoteCard from "../components/FromQuoteCard.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { describeCredential, describeLine, describeProject } from "../lib/activity.ts";
  import { dateTime, money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { clientLabel, leadLabel, ownerOptions, ownerValue, parseOwner } from "../lib/projects.ts";
  import { PROJECT_STATUSES, type AuditEntry, type Client, type Lead, type Project, type ProjectService, type ProjectStatus, type ProposalRow, type Quote } from "../lib/types.ts";

  let { id, version, clients, leads, quotes, proposals = [] }: { id: string; version: number; clients: Client[]; leads: Lead[]; quotes: Quote[]; proposals?: ProposalRow[] } = $props();

  let project = $state<Project | null | undefined>(undefined);
  let lines = $state<ProjectService[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let loadError = $state("");
  // What is wrong with each field of the details form, shown under it.
  let errors = $state<{ name?: string; owner?: string }>({});
  let saving = $state<"" | "details" | "notes">("");
  let confirm: Confirm;

  // Editable copies
  let details = $state({ name: "", owner: "", due_on: "" });
  let notes = $state("");

  async function load() {
    try {
      const [p, l, a] = await Promise.all([db.project(id), db.projectServices(id), db.projectActivity(id)]);
      project = p; lines = l; activity = a;
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (project === undefined) loadError = m;
      else toast.error(`Couldn't refresh this project. ${m}`);
    }
  }
  // The forms fill in when the saved values change (the first load, or after
  // a save), never on a plain reload, so a reload can't wipe what is being typed.
  const savedDetails = $derived(project ? JSON.stringify({ name: project.name, owner: ownerValue(project), due_on: project.due_on ?? "" }) : "");
  $effect(() => {
    if (savedDetails) details = JSON.parse(savedDetails);
  });
  const savedNotes = $derived(project ? project.notes ?? "" : null);
  $effect(() => {
    if (savedNotes !== null) notes = savedNotes;
  });
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
  // The quote this project was made from (Convert to project on a quote).
  const fromQuote = $derived(project?.proposal_id ? proposals.find((p) => p.id === project!.proposal_id) ?? null : null);
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

  /** Run an action, say how it went (the message shows wherever you are on the page), and reload. True when it worked. */
  async function run(fn: () => Promise<void>, ok = ""): Promise<boolean> {
    let worked = true;
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      worked = false;
      toast.error(messageOf(e, "That didn't go through. Try again."));
    }
    await load();
    return worked;
  }
  async function saveDetails(e: SubmitEvent) {
    e.preventDefault();
    errors = {};
    if (!details.name.trim()) errors.name = "Give the project a name.";
    const o = parseOwner(details.owner);
    if (!o) errors.owner = "Pick the client or lead it's for.";
    if (!o || errors.name) {
      document.getElementById(errors.name ? "p-name" : "p-for")?.focus();
      return;
    }
    saving = "details";
    await run(() => db.updateProject(id, { name: details.name.trim(), ...o, due_on: details.due_on || null }), "Details saved.");
    saving = "";
  }
  const setStatus = (s: ProjectStatus) => project && project.status !== s && run(() => db.updateProject(id, { status: s }));
  async function saveNotes() {
    saving = "notes";
    await run(() => db.updateProject(id, { notes: notes.trim() || null }), "Notes saved.");
    saving = "";
  }
  guardUnsaved(() => detailsDirty || notesDirty, () => confirm.ask({ title: "Leave without saving?", body: "Your changes to this project haven't been saved.", action: "Leave", danger: true }));
  async function reloadActivity() {
    activity = await db.projectActivity(id).catch(() => activity);
  }
  async function deleteProject() {
    if (!project) return;
    if (!(await confirm.ask({ title: `Delete ${project.name}?`, body: "This permanently deletes the project with its services, notes and saved credentials.", action: "Delete permanently", danger: true }))) return;
    const name = project.name;
    try {
      await db.deleteProject(id);
      toast.success(`${name} was deleted.`);
      location.hash = "#/projects";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete this project."));
    }
  }
  const toggleHidden = (a: AuditEntry) => run(() => db.hideActivity(a.id, !a.hidden));

  function describe(a: AuditEntry): string {
    if (a.table_name === "projects") return describeProject(a);
    if (a.table_name === "project_credentials") return describeCredential(a);
    return describeLine(a);
  }
</script>

<a class="back" href="#/projects"><Icon name="arrow-left" size={14} /> All projects</a>

{#if project === undefined}
  <LoadState error={loadError} what="this project" onretry={() => { loadError = ""; load(); }} />
{:else if project === null}
  <p class="empty">This project doesn't exist or was deleted.</p>
{:else}
  <PageHeader eyebrow={`Project${project.due_on ? ` · due ${shortDate(project.due_on + "T12:00:00")}` : ""}`} title={project.name}>
    {#snippet meta()}
      {#if owner}<p class="contact"><span>{owner.kind}</span><a href={owner.href}>{owner.label} <Icon name="arrow-right" size={14} /></a></p>{/if}
      {#if fromQuote}<p class="contact"><a class="qchip" href="#/quotes/{fromQuote.id}">From quote Q{fromQuote.number}{fromQuote.accepted_at ? `, accepted ${shortDate(fromQuote.accepted_at)}` : ""}</a></p>{/if}
    {/snippet}
    <div class="headvalue">
      <span class="big num">{money(once)}<small> one time</small></span>
      <span class="muted num">+ {money(monthly)}/mo · {money(monthly * 12)}/yr</span>
      <div class="headacts"><Menu label="More actions for this project" items={[{ label: "Delete project", danger: true, onselect: deleteProject }]} /></div>
    </div>
  </PageHeader>

  <StageButtons label="Status" options={PROJECT_STATUSES} value={project.status} onpick={setStatus} />

  <div class="cols">
    <div class="main">
      <ServiceLines
        {lines} {devices} noun="project"
        sub="What this project covers. Click a price or quantity to change it."
        empty="No services yet. Add what this project would include below."
        {hint}
        onadd={(l) => run(() => db.addProjectService({ ...l, project_id: id }))}
        onupdate={(l, patch) => run(() => db.updateProjectService(l.id, patch))}
        onremove={(l) => run(() => db.deleteProjectService(l.id))} />

      <section class="card">
        <div class="card-head"><div><h2 id="project-notes-h">Notes</h2><p class="sub" id="project-notes-d">Not encrypted. Keep passwords and keys in Credentials.</p></div></div>
        <textarea class="input" rows="6" maxlength="20000" placeholder="Scope, site details, contacts, next steps…" aria-labelledby="project-notes-h" aria-describedby="project-notes-d" bind:value={notes}></textarea>
        <div class="row"><button class="btn primary sm" disabled={!notesDirty || saving === "notes"} onclick={saveNotes}>{saving === "notes" ? "Saving…" : "Save notes"}</button></div>
      </section>

      <Credentials projectId={id} onchange={reloadActivity} />
    </div>

    <aside class="side">
      {#if fromQuote}<FromQuoteCard quote={fromQuote} />{/if}
      <section class="card">
        <div class="card-head"><h2>Details</h2></div>
        <form class="form" onsubmit={saveDetails} novalidate>
          <Field id="p-name" label="Name" required error={errors.name}>{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={details.name} />{/snippet}</Field>
          <Field id="p-for" label="For" required error={errors.owner}>
            {#snippet children(a)}
              <select {...a} class="input" bind:value={details.owner}>
                {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
                {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
              </select>
            {/snippet}
          </Field>
          <Field id="p-due" label="Due date">{#snippet children(a)}<input {...a} class="input" type="date" bind:value={details.due_on} />{/snippet}</Field>
          <div class="row"><button class="btn primary sm" disabled={!detailsDirty || saving === "details"}>{saving === "details" ? "Saving…" : "Save details"}</button></div>
        </form>
      </section>

      <ActivityCard {activity} {describe} ontoggle={toggleHidden} />
    </aside>
  </div>
{/if}

<Confirm bind:this={confirm} />

<style>
  textarea.input { width: 100%; }
  .qchip { display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--line-2); border-radius: 999px; font-size: var(--fs-sm); font-weight: 600; text-decoration: none; }
  .qchip:hover { background: var(--surface-2); }
  .row { display: flex; justify-content: flex-end; margin-top: 10px; }
  .form { display: flex; flex-direction: column; gap: 10px; }
  .form :global(.input) { height: var(--control-md); width: 100%; min-width: 0; }
</style>
