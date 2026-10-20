<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import ProjectsCard from "../components/ProjectsCard.svelte";
  import ServiceLines from "../components/ServiceLines.svelte";
  import { describeLine, describeProject } from "../lib/activity.ts";
  import { dateTime, money, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { CLIENT_STATUSES, type AuditEntry, type Client, type ClientService, type ClientStatus, type Project, type ProjectService } from "../lib/types.ts";

  let { id, version, projects, projectLines }: { id: string; version: number; projects: Project[]; projectLines: ProjectService[] } = $props();

  let client = $state<Client | null | undefined>(undefined);
  let lines = $state<ClientService[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let error = $state("");
  let saved = $state("");
  let confirm: Confirm;
  let showHidden = $state(false);

  // Editable copies
  let details = $state({ company: "", contact_name: "", email: "", phone: "", address: "", workstations: 0, servers: 0, started_on: "" });
  let notes = $state("");

  async function load() {
    try {
      const [c, l, a] = await Promise.all([db.client(id), db.clientServices(id), db.clientActivity(id)]);
      client = c; lines = l; activity = a;
      if (c) {
        details = { company: c.company ?? "", contact_name: c.contact_name ?? "", email: c.email ?? "", phone: c.phone ?? "", address: c.address ?? "", workstations: c.workstations, servers: c.servers, started_on: c.started_on ?? "" };
        notes = c.notes ?? "";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load this client.";
    }
  }
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
  const visibleActivity = $derived(activity.filter((a) => showHidden || !a.hidden));
  const hiddenCount = $derived(activity.filter((a) => a.hidden).length);
  const title = $derived(client ? client.company || client.contact_name || "Unnamed client" : "");

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
  const nn = (s: string) => s.trim() || null;
  async function saveDetails(e: SubmitEvent) {
    e.preventDefault();
    if (!details.company.trim() && !details.contact_name.trim()) { error = "Add a company or a contact name."; return; }
    await run(() => db.updateClient(id, {
      company: nn(details.company), contact_name: nn(details.contact_name), email: nn(details.email.toLowerCase()), phone: nn(details.phone),
      address: nn(details.address), workstations: Math.max(0, Math.round(details.workstations || 0)), servers: Math.max(0, Math.round(details.servers || 0)),
      started_on: details.started_on || null,
    }), "Details saved");
  }
  const setStatus = (s: ClientStatus) => client && client.status !== s && run(() => db.updateClient(id, { status: s }));
  const saveNotes = () => run(() => db.updateClient(id, { notes: nn(notes) }), "Notes saved");
  const devices = $derived(client ? client.workstations + client.servers : 0);

  async function deleteClient() {
    const also = projects.length ? `, their services list, and their ${projects.length === 1 ? "project" : `${projects.length} projects`} (with any saved credentials)` : " and their services list";
    if (!(await confirm.ask({ title: `Delete ${title}?`, body: `This permanently deletes the client${also}. To keep the history, set their status to Former instead.`, action: "Delete permanently", danger: true }))) return;
    try {
      await db.deleteClient(id);
      location.hash = "#/clients";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't delete.";
    }
  }
  const toggleHidden = (a: AuditEntry) => run(() => db.hideActivity(a.id, !a.hidden));

  function describe(a: AuditEntry): string {
    const n = a.new_data ?? {}, o = a.old_data ?? {};
    if (a.table_name === "clients") {
      if (a.action === "insert") return n.lead_id ? "Client created from lead" : "Client added";
      if (n.status !== o.status) return `Status ${STATUS_LABEL[String(o.status)]} → ${STATUS_LABEL[String(n.status)]}`;
      if (n.notes !== o.notes) return "Notes updated";
      return "Details updated";
    }
    if (a.table_name === "projects") return describeProject(a);
    return describeLine(a);
  }
  const tel = (p: string) => "tel:" + p.replace(/[^0-9+]/g, "");
</script>

<a class="back" href="#/clients">← All clients</a>

{#if client === undefined}
  <p class="muted">Loading…</p>
{:else if client === null}
  <p class="empty">{error || "This client doesn't exist or was deleted."}</p>
{:else}
  <header class="head">
    <div>
      <p class="eyebrow">Client{client.started_on ? ` · since ${shortDate(client.started_on + "T12:00:00")}` : ""}</p>
      <h1>{title}</h1>
      <p class="contact">
        {#if client.company && client.contact_name}<span>{client.contact_name}</span>{/if}
        {#if client.email}<a href="mailto:{client.email}">{client.email}</a>{/if}
        {#if client.phone}<a href={tel(client.phone)}>{phone(client.phone)}</a>{/if}
        {#if client.lead_id}<a href="#/leads/{client.lead_id}">Original lead →</a>{/if}
      </p>
    </div>
    <div class="value">
      <span class="big num">{money(monthly)}<small>/mo</small></span>
      <span class="muted num">{money(once)} one time · {money(monthly * 12)}/yr</span>
      <button class="btn sm ghost del" onclick={deleteClient}>Delete client</button>
    </div>
  </header>

  <div class="stages" role="group" aria-label="Status">
    {#each CLIENT_STATUSES as s (s)}
      <button class="stage st-{s}" aria-pressed={client.status === s} onclick={() => setStatus(s)}><i aria-hidden="true"></i>{STATUS_LABEL[s]}</button>
    {/each}
    {#if saved}<span class="saved">✓ {saved}</span>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="cols">
    <div class="main">
      <ServiceLines
        {lines} {devices} noun="client"
        sub="What they pay you for. Click a price or quantity to change it."
        empty="No services yet. Add what this client pays for below."
        hint="Per-device services start at list price × this client's {devices} {devices === 1 ? 'device' : 'devices'}. You can change the price and quantity after adding."
        onadd={(l) => run(() => db.addClientService({ ...l, client_id: id }))}
        onupdate={(l, patch) => run(() => db.updateClientService(l.id, patch), "Saved")}
        onremove={(l) => run(() => db.deleteClientService(l.id))}
        onerror={(m) => (error = m)} />

      <ProjectsCard {projects} lines={projectLines} owner={{ lead_id: null, client_id: id }} noun="client" />

      <section class="card">
        <div class="card-head"><h2>Notes</h2></div>
        <textarea class="input" rows="4" maxlength="10000" placeholder="Contract terms, renewal dates, quirks…" bind:value={notes}></textarea>
        <div class="row"><button class="btn primary sm" disabled={!notesDirty} onclick={saveNotes}>Save notes</button></div>
      </section>
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Details</h2></div>
        <form class="form" onsubmit={saveDetails}>
          <div class="field"><label for="d-co">Company</label><input id="d-co" class="input" maxlength="160" bind:value={details.company} /></div>
          <div class="field"><label for="d-ct">Contact</label><input id="d-ct" class="input" maxlength="120" bind:value={details.contact_name} /></div>
          <div class="field"><label for="d-em">Email</label><input id="d-em" class="input" type="email" maxlength="254" bind:value={details.email} /></div>
          <div class="field"><label for="d-ph">Phone</label><input id="d-ph" class="input" type="tel" maxlength="40" bind:value={details.phone} /></div>
          <div class="field"><label for="d-ad">Address</label><input id="d-ad" class="input" maxlength="300" bind:value={details.address} /></div>
          <div class="two">
            <div class="field"><label for="d-ws">Workstations</label><input id="d-ws" class="input num" type="number" min="0" bind:value={details.workstations} /></div>
            <div class="field"><label for="d-sv">Servers</label><input id="d-sv" class="input num" type="number" min="0" bind:value={details.servers} /></div>
          </div>
          <div class="field"><label for="d-st">Client since</label><input id="d-st" class="input" type="date" bind:value={details.started_on} /></div>
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
  .contact { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; color: var(--text-2); }
  .contact a { color: var(--lime); text-decoration: none; overflow-wrap: anywhere; }
  .contact a:hover { text-decoration: underline; }
  .value { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .big { font-size: 34px; font-weight: 650; letter-spacing: -0.03em; color: var(--lime); }
  .big small { font-size: 16px; color: var(--muted); }
  .del { color: var(--critical); margin-top: 8px; }
  .stages { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 20px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface); color: var(--text-2); font-size: 13px; font-weight: 600; transition: background 0.2s, color 0.2s, border-color 0.2s; }
  .stage:hover { background: var(--surface-2); color: var(--text); }
  .stage[aria-pressed="true"] { background: var(--surface-3); color: var(--text); border-color: var(--text-2); }
  .stage i { width: 8px; height: 8px; border-radius: 50%; }
  .st-active i { background: var(--good); } .st-paused i { background: var(--warning); } .st-former i { background: var(--st-lost); }
  .saved { font-size: 13px; color: var(--good-text); animation: rise 0.3s var(--ease) both; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
  .main, .side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; border-radius: 6px; padding: 2px 6px; transition: color 0.15s, background 0.15s; }
  .x:hover { color: var(--critical); background: var(--surface-2); }
  textarea.input { width: 100%; }
  .row { display: flex; justify-content: flex-end; margin-top: 10px; }
  .form { display: flex; flex-direction: column; gap: 10px; }
  .form .input { height: 38px; width: 100%; min-width: 0; }
  .form .field { min-width: 0; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
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
