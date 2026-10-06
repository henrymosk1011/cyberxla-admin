<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import { catalog } from "../lib/store.svelte.ts";
  import { lineAmount, unitPrice } from "../lib/catalog.ts";
  import { dateTime, money, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { CLIENT_STATUSES, type AuditEntry, type Client, type ClientService, type ClientStatus } from "../lib/types.ts";

  let { id, version }: { id: string; version: number } = $props();

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
  let picking = $state(false);
  let search = $state("");
  let custom = $state({ name: "", billing: "monthly" as "monthly" | "once", amount: 0 });

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
  const byId = $derived(new Map(catalog.services.map((s) => [s.id, s])));
  const available = $derived.by(() => {
    const s = search.trim().toLowerCase();
    const have = new Set(lines.map((l) => l.service_id).filter(Boolean));
    return catalog.categories.map((c) => ({
      name: c.name,
      items: catalog.services.filter((x) => x.category_id === c.id && x.active && !have.has(x.id) && (!s || x.name.toLowerCase().includes(s))),
    })).filter((g) => g.items.length);
  });
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
  const nextSort = () => (lines.length ? Math.max(...lines.map((l) => l.sort)) + 10 : 0);

  async function addFromCatalog(sid: string) {
    const s = byId.get(sid)!;
    await run(() => db.addClientService({
      client_id: id, service_id: s.id, name: s.name, billing: s.unit === "dev" || s.unit === "mo" ? "monthly" : "once",
      amount: lineAmount(s, client?.workstations ?? 0, client?.servers ?? 0), notes: null, sort: nextSort(),
    }));
  }
  async function addCustom(e: SubmitEvent) {
    e.preventDefault();
    if (!custom.name.trim()) return;
    await run(() => db.addClientService({ client_id: id, service_id: null, name: custom.name.trim(), billing: custom.billing, amount: Math.max(0, Number(custom.amount) || 0), notes: null, sort: nextSort() }));
    custom = { name: "", billing: "monthly", amount: 0 };
  }
  async function updateLine(l: ClientService, patch: Partial<ClientService>) {
    if (patch.amount !== undefined) {
      if (!Number.isFinite(patch.amount) || patch.amount < 0) { error = "Enter an amount of 0 or more."; await load(); return; }
      if (patch.amount === l.amount) return;
    }
    if (patch.notes !== undefined && (patch.notes ?? "") === (l.notes ?? "")) return;
    await run(() => db.updateClientService(l.id, patch), "Saved");
  }
  async function removeLine(l: ClientService) {
    if (!(await confirm.ask({ title: `Remove ${l.name}?`, body: `${money(l.amount)}${l.billing === "monthly" ? "/mo" : " one time"} will come off this client.`, action: "Remove", danger: true }))) return;
    await run(() => db.deleteClientService(l.id));
  }
  async function deleteClient() {
    if (!(await confirm.ask({ title: `Delete ${title}?`, body: "This permanently deletes the client and their services list. To keep the history, set their status to Former instead.", action: "Delete permanently", danger: true }))) return;
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
    const amt = (d: Record<string, unknown>) => `${money(Number(d.amount ?? 0))}${d.billing === "monthly" ? "/mo" : " one time"}`;
    if (a.table_name === "clients") {
      if (a.action === "insert") return n.lead_id ? "Client created from lead" : "Client added";
      if (n.status !== o.status) return `Status ${STATUS_LABEL[String(o.status)]} → ${STATUS_LABEL[String(n.status)]}`;
      if (n.notes !== o.notes) return "Notes updated";
      return "Details updated";
    }
    if (a.action === "insert") return `Added ${n.name} (${amt(n)})`;
    if (a.action === "delete") return `Removed ${o.name} (${amt(o)})`;
    if (n.amount !== o.amount || n.billing !== o.billing) return `${n.name}: ${amt(o)} → ${amt(n)}`;
    return `${n.name} updated`;
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
      <section class="card">
        <div class="card-head"><div><h2>Services</h2><p class="sub">What they pay you for. Click an amount to change it.</p></div></div>
        {#if lines.length}
          <ul class="lines">
            {#each lines as l (l.id)}
              {@const cat = l.service_id ? byId.get(l.service_id) : undefined}
              <li>
                <span class="qdot" class:mo={l.billing === "monthly"} class:once={l.billing !== "monthly"} aria-hidden="true"></span>
                <div class="nm">
                  <span class="name">{l.name}{#if !l.service_id}<span class="tag">Custom</span>{/if}</span>
                  <input class="note" placeholder={cat ? `List price ${unitPrice(cat)}` : "Add a note"} value={l.notes ?? ""} maxlength="500" aria-label="Note for {l.name}"
                    onchange={(e) => updateLine(l, { notes: e.currentTarget.value.trim() || null })} />
                </div>
                <select class="input billing" aria-label="Billing for {l.name}" value={l.billing} onchange={(e) => updateLine(l, { billing: e.currentTarget.value as "monthly" | "once" })}>
                  <option value="monthly">Monthly</option>
                  <option value="once">One time</option>
                </select>
                <label class="amount">
                  <span aria-hidden="true">$</span>
                  <input class="num" type="number" min="0" step="0.01" value={l.amount} aria-label="Amount for {l.name}"
                    onchange={(e) => updateLine(l, { amount: e.currentTarget.valueAsNumber })}
                    onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                </label>
                <button class="x" aria-label="Remove {l.name}" title="Remove" onclick={() => removeLine(l)}>×</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No services yet. Add what this client pays for below.</p>
        {/if}

        {#if picking}
          <div class="picker">
            <div class="phead">
              <input class="input" type="search" placeholder="Search your services" aria-label="Search services" bind:value={search} />
              <button type="button" class="btn ghost sm" onclick={() => { picking = false; search = ""; }}>Done</button>
            </div>
            {#each available as g (g.name)}
              <p class="eyebrow catname">{g.name}</p>
              <ul class="options">
                {#each g.items as s (s.id)}
                  <li><button type="button" onclick={() => addFromCatalog(s.id)}>
                    <span>{s.name}</span>
                    <span class="muted num">{money(lineAmount(s, client.workstations, client.servers))}{s.unit === "dev" || s.unit === "mo" ? "/mo" : " one time"}</span>
                    <span class="plus" aria-hidden="true">+</span>
                  </button></li>
                {/each}
              </ul>
            {:else}
              <p class="muted none">{search ? "No matching services." : "Every service is already on this client."}</p>
            {/each}
            <form class="customrow" onsubmit={addCustom}>
              <p class="eyebrow catname">Custom service</p>
              <div class="cr">
                <input class="input" placeholder="Name (e.g. On-site visit)" maxlength="120" bind:value={custom.name} aria-label="Custom service name" />
                <select class="input" bind:value={custom.billing} aria-label="Custom service billing"><option value="monthly">Monthly</option><option value="once">One time</option></select>
                <input class="input num" type="number" min="0" step="0.01" bind:value={custom.amount} aria-label="Custom service amount" />
                <button class="btn sm" disabled={!custom.name.trim()}>Add</button>
              </div>
            </form>
          </div>
          <p class="muted hint">Suggested prices use this client's {client.workstations} workstations and {client.servers} servers. You can change any amount after adding.</p>
        {:else}
          <button class="btn sm addbtn" onclick={() => (picking = true)}>+ Add service</button>
        {/if}

        <div class="totals">
          <div><span class="muted">Monthly</span><strong class="num">{money(monthly)}</strong></div>
          <div><span class="muted">One time</span><strong class="num">{money(once)}</strong></div>
          <div><span class="muted">Per year</span><strong class="num">{money(monthly * 12)}</strong></div>
        </div>
      </section>

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
  .lines { list-style: none; }
  .lines li { display: grid; grid-template-columns: 16px minmax(0, 1fr) 120px 130px 28px; gap: 10px; align-items: center; padding: 10px 4px; border-top: 1px solid var(--line); animation: rise 0.3s var(--ease) both; }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .name { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tag { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); border: 1px solid var(--line-2); border-radius: 999px; padding: 1px 6px; }
  .note { border: 0; background: transparent; color: var(--muted); font-size: 12px; padding: 2px 0; outline: none; border-bottom: 1px dashed transparent; width: 100%; }
  .note:hover, .note:focus { border-bottom-color: var(--line-2); color: var(--text-2); }
  .billing { height: 34px; font-size: 13px; padding: 0 32px 0 10px; background-position: right 10px center; }
  .amount { display: flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--ink); transition: border-color 0.15s; }
  .amount:focus-within { border-color: var(--lime); }
  .amount span { color: var(--muted); }
  .amount input { width: 100%; border: 0; background: transparent; outline: none; text-align: right; font-weight: 600; -moz-appearance: textfield; appearance: textfield; }
  .amount input::-webkit-inner-spin-button, .amount input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .qdot { width: 8px; height: 8px; border-radius: 50%; justify-self: center; }
  .qdot.mo { background: var(--lime); box-shadow: 0 0 6px rgba(214, 255, 63, 0.4); }
  .qdot.once { border: 1.5px solid var(--muted); }
  .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; border-radius: 6px; padding: 2px 6px; transition: color 0.15s, background 0.15s; }
  .x:hover { color: var(--critical); background: var(--surface-2); }
  .addbtn { margin-top: 12px; }
  .picker { margin-top: 12px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--ink); padding: 12px; max-height: 420px; overflow-y: auto; animation: rise 0.3s var(--ease) both; }
  .phead { display: flex; gap: 8px; position: sticky; top: -12px; background: var(--ink); padding-bottom: 8px; z-index: 1; }
  .phead .input { flex: 1; height: 36px; }
  .catname { margin: 12px 4px 6px; }
  .options { list-style: none; }
  .options button { width: 100%; display: grid; grid-template-columns: 1fr auto 24px; gap: 10px; align-items: center; text-align: left; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; font-size: 14px; transition: background 0.15s; }
  .options button:hover { background: var(--surface-2); }
  .options .muted { font-size: 12px; }
  .plus { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-2); color: var(--text-2); transition: background 0.2s, color 0.2s, transform 0.3s var(--ease-spring); }
  .options button:hover .plus { background: var(--lime); color: var(--on-lime); border-color: var(--lime); transform: rotate(90deg); }
  .none { padding: 8px 4px; font-size: 13px; }
  .cr { display: grid; grid-template-columns: minmax(0, 1fr) 120px 110px auto; gap: 8px; align-items: center; }
  .cr .input { height: 36px; }
  .cr select.input { padding: 0 32px 0 10px; background-position: right 10px center; }
  .hint { font-size: 12px; margin-top: 8px; }
  .totals { display: flex; gap: 32px; padding: 16px 4px 4px; margin-top: 12px; border-top: 1px solid var(--line-2); flex-wrap: wrap; }
  .totals div { display: flex; flex-direction: column; }
  .totals strong { font-size: 20px; font-weight: 650; }
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
  @media (max-width: 640px) {
    .lines li { grid-template-columns: 16px minmax(0, 1fr) 28px; }
    .billing { grid-column: 2; }
    .amount { grid-column: 2; }
    .lines li > .x { grid-column: 3; grid-row: 1; }
    .cr { grid-template-columns: 1fr 1fr; }
    .cr .input:first-child { grid-column: 1 / -1; }
  }
</style>
