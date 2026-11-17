<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { tick } from "svelte";
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import ActivityCard from "../components/ActivityCard.svelte";
  import Field from "../components/Field.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import StageButtons from "../components/StageButtons.svelte";
  import Modal from "../components/Modal.svelte";
  import Menu from "../components/Menu.svelte";
  import ProjectsCard from "../components/ProjectsCard.svelte";
  import QuotesCard from "../components/QuotesCard.svelte";
  import ServiceLines from "../components/ServiceLines.svelte";
  import ClientReportsCard from "../components/ClientReportsCard.svelte";
  import LoadState from "../components/LoadState.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { describeLine, describeProject, describeReport } from "../lib/activity.ts";
  import { money, num, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { EMAIL } from "../lib/reports.ts";
  import { CLIENT_STATUSES, type AuditEntry, type Client, type ClientService, type ClientStatus, type Project, type ProjectService, type ProposalRow } from "../lib/types.ts";

  let { id, version, projects, projectLines, proposals = [] }: { id: string; version: number; projects: Project[]; projectLines: ProjectService[]; proposals?: ProposalRow[] } = $props();

  let client = $state<Client | null | undefined>(undefined);
  let lines = $state<ClientService[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let loadError = $state("");
  // What is wrong with each field of the details form, shown under it.
  let errors = $state<{ company?: string; email?: string }>({});
  // The card shows the details; Edit opens the form.
  let editingDetails = $state(false);
  let saving = $state<"" | "details" | "notes">("");
  let reportsDirty = $state(false);
  let confirm: Confirm;

  // Editable copies
  const detailsOf = (c: Client) => ({ company: c.company ?? "", contact_name: c.contact_name ?? "", email: c.email ?? "", phone: c.phone ?? "", address: c.address ?? "", workstations: c.workstations, servers: c.servers, started_on: c.started_on ?? "" });
  let details = $state({ company: "", contact_name: "", email: "", phone: "", address: "", workstations: 0, servers: 0, started_on: "" });
  let notes = $state("");

  async function load() {
    try {
      const [c, l, a] = await Promise.all([db.client(id), db.clientServices(id), db.clientActivity(id)]);
      client = c; lines = l; activity = a;
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (client === undefined) loadError = m;
      else toast.error(`Couldn't refresh this client. ${m}`);
    }
  }
  // The forms fill in when the saved values change (the first load, or after
  // a save), never on a plain reload, so a reload can't wipe what is being typed.
  const savedDetails = $derived(client ? JSON.stringify(detailsOf(client)) : "");
  $effect(() => {
    if (savedDetails) details = JSON.parse(savedDetails);
  });
  const savedNotes = $derived(client ? client.notes ?? "" : null);
  $effect(() => {
    if (savedNotes !== null) notes = savedNotes;
  });
  $effect(() => {
    void id; void version;
    load();
  });

  const monthly = $derived(lines.filter((l) => l.billing === "monthly").reduce((s, l) => s + l.amount, 0));
  const once = $derived(lines.filter((l) => l.billing === "once").reduce((s, l) => s + l.amount, 0));
  const detailsDirty = $derived(!!client && (
    details.company !== (client.company ?? "") || details.contact_name !== (client.contact_name ?? "") || details.email !== (client.email ?? "") ||
    details.phone !== (client.phone ?? "") || details.address !== (client.address ?? "") || details.workstations !== client.workstations ||
    details.servers !== client.servers || details.started_on !== (client.started_on ?? "")));
  const notesDirty = $derived(!!client && notes !== (client.notes ?? ""));
  const title = $derived(client ? client.company || client.contact_name || "Unnamed client" : "");

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
  const nn = (s: string) => s.trim() || null;
  async function saveDetails(e: SubmitEvent) {
    e.preventDefault();
    errors = {};
    if (!details.company.trim() && !details.contact_name.trim()) errors.company = "Add a company or a contact name.";
    if (details.email.trim() && !EMAIL.test(details.email.trim())) errors.email = "That doesn't look like an email address.";
    if (errors.company || errors.email) {
      await tick();
      document.getElementById(errors.company ? "d-co" : "d-em")?.focus();
      return;
    }
    saving = "details";
    const ok = await run(() => db.updateClient(id, {
      company: nn(details.company), contact_name: nn(details.contact_name), email: nn(details.email.toLowerCase()), phone: nn(details.phone),
      address: nn(details.address), workstations: Math.max(0, Math.round(details.workstations || 0)), servers: Math.max(0, Math.round(details.servers || 0)),
      started_on: details.started_on || null,
    }), "Details saved.");
    saving = "";
    if (ok) editingDetails = false;
  }
  function cancelDetails() {
    editingDetails = false;
    errors = {};
    if (savedDetails) details = JSON.parse(savedDetails);
  }
  const setStatus = (s: ClientStatus) => client && client.status !== s && run(() => db.updateClient(id, { status: s }));
  async function saveNotes() {
    saving = "notes";
    await run(() => db.updateClient(id, { notes: nn(notes) }), "Notes saved.");
    saving = "";
  }
  guardUnsaved(() => detailsDirty || notesDirty || reportsDirty, () => confirm.ask({ title: "Leave without saving?", body: "Your changes to this client haven't been saved.", action: "Leave", danger: true }));
  const devices = $derived(client ? client.workstations + client.servers : 0);

  async function deleteClient() {
    const also = projects.length ? `, their services list, and their ${projects.length === 1 ? "project" : `${projects.length} projects`} (with any saved credentials)` : " and their services list";
    if (!(await confirm.ask({ title: `Delete ${title}?`, body: `This permanently deletes the client${also}. To keep the history, set their status to Former instead.`, action: "Delete permanently", danger: true }))) return;
    try {
      await db.deleteClient(id);
      toast.success(`${title} was deleted.`);
      location.hash = "#/clients";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete this client."));
    }
  }
  const toggleHidden = (a: AuditEntry) => run(() => db.hideActivity(a.id, !a.hidden));

  function describe(a: AuditEntry): string | null {
    const n = a.new_data ?? {}, o = a.old_data ?? {};
    if (a.table_name === "reports") return describeReport(a);
    if (a.table_name === "clients") {
      if (a.action === "insert") return n.lead_id ? "Client created from lead" : "Client added";
      if (n.status !== o.status) return `Status ${STATUS_LABEL[String(o.status)]} → ${STATUS_LABEL[String(n.status)]}`;
      if (n.reports_enabled !== o.reports_enabled) return n.reports_enabled ? "Reports turned on" : "Reports turned off";
      if (["action1_group", "report_recipients", "report_cc", "report_exclude", "unifi_console"].some((k) => JSON.stringify(n[k]) !== JSON.stringify(o[k]))) return "Report settings updated";
      if (n.notes !== o.notes) return "Notes updated";
      return "Details updated";
    }
    if (a.table_name === "projects") return describeProject(a);
    return describeLine(a);
  }
  const tel = (p: string) => "tel:" + p.replace(/[^0-9+]/g, "");
</script>

<a class="back" href="#/clients"><Icon name="arrow-left" size={14} /> All clients</a>

{#if client === undefined}
  <LoadState error={loadError} what="this client" onretry={() => { loadError = ""; load(); }} />
{:else if client === null}
  <p class="empty">This client doesn't exist or was deleted.</p>
{:else}
  {@const c = client}
  <PageHeader eyebrow={`Client${c.started_on ? ` · since ${shortDate(c.started_on + "T12:00:00")}` : ""}`} {title}>
    {#snippet meta()}
      <p class="contact">
        {#if c.company && c.contact_name}<span>{c.contact_name}</span>{/if}
        {#if c.email}<a href="mailto:{c.email}">{c.email}</a>{/if}
        {#if c.phone}<a href={tel(c.phone)}>{phone(c.phone)}</a>{/if}
        {#if c.lead_id}<a href="#/leads/{c.lead_id}">Original lead <Icon name="arrow-right" size={14} /></a>{/if}
      </p>
    {/snippet}
    <div class="headvalue">
      <span class="big num">{money(monthly)}<small>/mo</small></span>
      <span class="muted num">{money(once)} one time · {money(monthly * 12)}/yr</span>
      <div class="headacts"><Menu label="More actions for this client" items={[{ label: "Delete client", danger: true, onselect: deleteClient }]} /></div>
    </div>
  </PageHeader>

  <StageButtons label="Status" options={CLIENT_STATUSES} value={client.status} onpick={setStatus} />

  <div class="cols">
    <div class="main">
      <ServiceLines
        {lines} {devices} noun="client"
        sub="What they pay you for. Click a price or quantity to change it."
        empty="No services yet. Add what this client pays for below."
        hint="Per-device services start at list price × this client's {devices} {devices === 1 ? 'device' : 'devices'}. You can change the price and quantity after adding."
        onadd={(l) => run(() => db.addClientService({ ...l, client_id: id }))}
        onupdate={(l, patch) => run(() => db.updateClientService(l.id, patch))}
        onremove={(l) => run(() => db.deleteClientService(l.id))} />

      <ProjectsCard {projects} lines={projectLines} owner={{ lead_id: null, client_id: id }} noun="client" />
      <QuotesCard {proposals} owner="client:{id}" noun="client" />

      <section class="card">
        <div class="card-head"><h2 id="client-notes-h">Notes</h2></div>
        <textarea class="input" rows="4" maxlength="10000" placeholder="Contract terms, renewal dates, quirks…" aria-labelledby="client-notes-h" bind:value={notes}></textarea>
        <div class="row"><button class="btn primary sm" disabled={!notesDirty || saving === "notes"} onclick={saveNotes}>{saving === "notes" ? "Saving…" : "Save notes"}</button></div>
      </section>
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Details</h2><button class="btn sm" onclick={() => (editingDetails = true)}>Edit<span class="sr-only"> details</span></button></div>
        <dl class="factlist">
          <div><dt>Company</dt><dd class:unset={!client.company}>{client.company || "Not set"}</dd></div>
          <div><dt>Contact name</dt><dd class:unset={!client.contact_name}>{client.contact_name || "Not set"}</dd></div>
          <div><dt>Email</dt><dd class:unset={!client.email}>{#if client.email}<a href="mailto:{client.email}">{client.email}</a>{:else}Not set{/if}</dd></div>
          <div><dt>Phone</dt><dd class:unset={!client.phone}>{#if client.phone}<a href={tel(client.phone)}>{phone(client.phone)}</a>{:else}Not set{/if}</dd></div>
          <div><dt>Address</dt><dd class:unset={!client.address}>{client.address || "Not set"}</dd></div>
          <div><dt>Devices</dt><dd>{num(client.workstations)} {client.workstations === 1 ? "workstation" : "workstations"}, {num(client.servers)} {client.servers === 1 ? "server" : "servers"}</dd></div>
          <div><dt>Client since</dt><dd class:unset={!client.started_on}>{client.started_on ? shortDate(client.started_on + "T12:00:00") : "Not set"}</dd></div>
        </dl>
        {#if detailsDirty && !editingDetails}<p class="draft">You have unsaved changes here. <button class="linkbtn" onclick={() => (editingDetails = true)}>Keep editing</button></p>{/if}
      </section>

      <ClientReportsCard {client} onsaved={load} bind:dirty={reportsDirty} />

      <!-- Report bookkeeping (renders, send attempts) has no wording and stays off the timeline. -->
      <ActivityCard {activity} {describe} ontoggle={toggleHidden} />
    </aside>
  </div>
{/if}

<Modal open={editingDetails} title="Edit details" onclose={() => (editingDetails = false)} persistent={detailsDirty}>
  <form class="form" onsubmit={saveDetails} novalidate>
    <p class="hint">A company or a contact name is required.</p>
    <div class="grid2">
      <Field id="d-co" label="Company" error={errors.company}>{#snippet children(a)}<input {...a} class="input" maxlength="160" bind:value={details.company} />{/snippet}</Field>
      <Field id="d-ct" label="Contact name">{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={details.contact_name} />{/snippet}</Field>
      <Field id="d-em" label="Email" error={errors.email}>{#snippet children(a)}<input {...a} class="input" type="email" maxlength="254" bind:value={details.email} />{/snippet}</Field>
      <Field id="d-ph" label="Phone">{#snippet children(a)}<input {...a} class="input" type="tel" maxlength="40" bind:value={details.phone} />{/snippet}</Field>
      <Field id="d-ad" label="Address" wide>{#snippet children(a)}<input {...a} class="input" maxlength="300" bind:value={details.address} />{/snippet}</Field>
      <Field id="d-ws" label="Workstations">{#snippet children(a)}<input {...a} class="input num" type="number" min="0" bind:value={details.workstations} />{/snippet}</Field>
      <Field id="d-sv" label="Servers">{#snippet children(a)}<input {...a} class="input num" type="number" min="0" bind:value={details.servers} />{/snippet}</Field>
      <Field id="d-st" label="Client since">{#snippet children(a)}<input {...a} class="input" type="date" bind:value={details.started_on} />{/snippet}</Field>
    </div>
    <div class="row">
      <button type="button" class="btn ghost" onclick={cancelDetails}>Cancel</button>
      <button class="btn primary" disabled={!detailsDirty || saving === "details"}>{saving === "details" ? "Saving…" : "Save details"}</button>
    </div>
  </form>
</Modal>

<Confirm bind:this={confirm} />

<style>
  textarea.input { width: 100%; }
  .row { display: flex; justify-content: flex-end; margin-top: 10px; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .form :global(.input) { width: 100%; min-width: 0; }
  .form .row { gap: 8px; margin-top: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: var(--fs-sm); color: var(--muted); }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
</style>
