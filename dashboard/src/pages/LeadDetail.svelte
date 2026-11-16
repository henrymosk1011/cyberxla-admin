<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import Menu from "../components/Menu.svelte";
  import ProjectsCard from "../components/ProjectsCard.svelte";
  import QuoteEditor from "../components/QuoteEditor.svelte";
  import ActivityCard from "../components/ActivityCard.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import StageButtons from "../components/StageButtons.svelte";
  import LoadState from "../components/LoadState.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { describeProject } from "../lib/activity.ts";
  import { dateTime, money, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { LEAD_STATUSES, QUOTE_STATUSES, type AuditEntry, type Lead, type LeadStatus, type Note, type Project, type ProjectService, type Quote, type QuoteStatus } from "../lib/types.ts";

  let { id, version, onstatus, clientFor = null, onconverted, projects, projectLines }: {
    id: string; version: number; onstatus: (id: string, s: LeadStatus) => Promise<void>;
    clientFor?: string | null; onconverted?: () => void;
    projects: Project[]; projectLines: ProjectService[];
  } = $props();
  let converting = $state(false);

  async function convert() {
    if (!lead) return;
    if (!(await confirm.ask({
      title: `Convert ${lead.company || lead.name} to a client?`,
      body: `Creates a client with their contact details and the services and prices from their newest quote (you can change anything after).${projects.length ? " Their projects move to the client." : ""} The lead is marked Won.`,
      action: "Convert to client",
    }))) return;
    converting = true;
    try {
      const cid = await db.convertLead(id);
      onconverted?.();
      location.hash = `#/clients/${cid}`;
    } catch (e) {
      toast.error(messageOf(e, "Couldn't convert this lead."));
    } finally {
      converting = false;
    }
  }

  let lead = $state<Lead | null | undefined>(undefined);
  let quotes = $state<Quote[]>([]);
  let notes = $state<Note[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let draft = $state("");
  let saving = $state(false);
  let loadError = $state("");
  let showArchived = $state(false);
  // Per-quote line item filter, like the quote builder's.
  let itemFilter = $state<Record<string, "all" | "monthly" | "once">>({});
  let editing = $state<Record<string, boolean>>({});

  async function saveServices(q: Quote, ids: string[], ws: number, sv: number) {
    await db.updateQuoteServices(q.id, ids, ws, sv);
    editing[q.id] = false;
    await load();
  }
  let confirm: Confirm;

  const activeQuotes = $derived(quotes.filter((q) => !q.archived_at));
  const archivedQuotes = $derived(quotes.filter((q) => q.archived_at));

  /** Run an action and reload; a failure is said in a message that shows wherever you are on the page. */
  async function run(fn: () => Promise<void>, failMsg: string) {
    try {
      await fn();
    } catch (e) {
      toast.error(messageOf(e, failMsg));
    }
    await load();
  }
  // A note typed but not added yet: ask before leaving it behind.
  guardUnsaved(() => !!draft.trim(), () => confirm.ask({ title: "Leave without adding the note?", body: "The note you typed hasn't been added.", action: "Leave", danger: true }));

  async function toggleArchiveLead() {
    if (!lead) return;
    const archiving = !lead.archived_at;
    if (archiving && !(await confirm.ask({ title: "Archive this lead?", body: "It leaves your pipeline, board, and stats, but nothing is deleted. You can restore it any time from Leads → Archived.", action: "Archive" }))) return;
    await run(() => db.archiveLead(id, archiving), "Couldn't update the lead.");
  }
  async function deleteLead() {
    if (!lead) return;
    const name = lead.company || lead.name;
    const also = projects.length ? `, its notes, and its ${projects.length === 1 ? "project" : `${projects.length} projects`} (with any saved credentials)` : ", and its notes";
    if (!(await confirm.ask({ title: `Delete ${name}?`, body: `This permanently deletes the lead, all of its quotes${also}. This can't be undone. (Archive instead if you might need it later.)`, action: "Delete permanently", danger: true }))) return;
    try {
      await db.deleteLead(id);
      toast.success(`${name} was deleted.`);
      location.hash = "#/leads";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete the lead."));
    }
  }
  async function toggleArchiveQuote(q: Quote) {
    const archiving = !q.archived_at;
    if (archiving && !(await confirm.ask({ title: "Archive this quote?", body: "It's hidden from your stats and the lead's value, but kept. You can restore it under \"Archived quotes\".", action: "Archive" }))) return;
    await run(() => db.archiveQuote(q.id, archiving), "Couldn't update the quote.");
  }
  async function deleteQuote(q: Quote) {
    if (!(await confirm.ask({ title: "Delete this quote?", body: `The ${money(q.monthly_total)}/mo quote from ${dateTime(q.created_at)} will be permanently deleted. This can't be undone.`, action: "Delete permanently", danger: true }))) return;
    await run(() => db.deleteQuote(q.id), "Couldn't delete the quote.");
  }
  async function deleteNote(n: Note) {
    const preview = n.body.length > 80 ? n.body.slice(0, 80) + "…" : n.body;
    if (!(await confirm.ask({ title: "Delete this note?", body: `"${preview}" will be permanently deleted.`, action: "Delete", danger: true }))) return;
    await run(() => db.deleteNote(n.id), "Couldn't delete the note.");
  }
  async function toggleHidden(a: AuditEntry) {
    await run(() => db.hideActivity(a.id, !a.hidden), "Couldn't update the activity log.");
  }

  async function load() {
    try {
      const [l, q, n, a] = await Promise.all([db.lead(id), db.quotesFor(id), db.notesFor(id), db.activityFor(id)]);
      lead = l; quotes = q; notes = n; activity = a;
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (lead === undefined) loadError = m;
      else toast.error(`Couldn't refresh this lead. ${m}`);
    }
  }
  $effect(() => {
    void id; void version;
    load();
  });

  async function setStatus(s: LeadStatus) {
    if (!lead || lead.status === s) return;
    lead.status = s;
    await onstatus(id, s);
    load();
  }
  async function setQuoteStatus(q: Quote, s: QuoteStatus) {
    const before = q.status;
    q.status = s;
    try {
      await db.setQuoteStatus(q.id, s);
    } catch (e) {
      // Put the dropdown back and say why.
      q.status = before;
      toast.error(`Couldn't change the quote's status. ${messageOf(e, "Try again.")}`);
    }
    load();
  }
  async function addNote(e: SubmitEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    saving = true;
    try {
      await db.addNote(id, body);
      draft = "";
      await load();
    } catch (err) {
      toast.error(messageOf(err, "Couldn't save the note."));
    } finally {
      saving = false;
    }
  }

  function describe(a: AuditEntry): string {
    const n = a.new_data ?? {}, o = a.old_data ?? {};
    const who = a.actor_role === "authenticated" ? "You" : a.actor_role === "quote_intake" || a.actor_role === "postgres" ? "Website" : a.actor_role;
    const archivedChange = a.action === "update" && (n.archived_at ?? null) !== (o.archived_at ?? null);
    if (a.table_name === "leads") {
      if (a.action === "insert") return `${who}: lead created`;
      if (archivedChange) return `${who}: lead ${n.archived_at ? "archived" : "restored"}`;
      if (a.action === "update" && n.status === o.status && n.value_monthly !== o.value_monthly) return `Lead value updated to ${money(Number(n.value_monthly ?? 0))}/mo`;
      if (a.action === "update" && n.status !== o.status) return `${who}: stage ${STATUS_LABEL[String(o.status)] ?? o.status} → ${STATUS_LABEL[String(n.status)] ?? n.status}`;
      if (a.action === "update") return `${who}: lead details updated`;
      return `${who}: lead deleted`;
    }
    if (a.table_name === "quotes") {
      if (a.action === "insert") return `${who}: quote received (${money(Number(n.monthly_total ?? 0))}/mo)`;
      if (a.action === "delete") return `${who}: quote deleted (${money(Number(o.monthly_total ?? 0))}/mo)`;
      if (archivedChange) return `${who}: quote ${n.archived_at ? "archived" : "restored"}`;
      if (a.action === "update" && n.status !== o.status) return `${who}: quote ${STATUS_LABEL[String(n.status)]?.toLowerCase() ?? n.status}`;
      if (a.action === "update" && Array.isArray(n.items) && Array.isArray(o.items)) {
        const names = (xs: unknown[]) => new Map(xs.map((x) => [String((x as { id: string }).id), String((x as { name: string }).name)]));
        const before = names(o.items), after = names(n.items);
        const add = [...after].filter(([id]) => !before.has(id)).map(([, nm]) => nm);
        const rem = [...before].filter(([id]) => !after.has(id)).map(([, nm]) => nm);
        const parts = [
          add.length ? `added ${add.join(", ")}` : "",
          rem.length ? `removed ${rem.join(", ")}` : "",
          n.workstations !== o.workstations || n.servers !== o.servers ? `devices ${o.workstations}+${o.servers} → ${n.workstations}+${n.servers}` : "",
        ].filter(Boolean);
        if (parts.length) return `${who}: quote edited, ${parts.join("; ")} (now ${money(Number(n.monthly_total ?? 0))}/mo)`;
      }
      return `${who}: quote updated`;
    }
    if (a.table_name === "projects") return describeProject(a);
    if (a.table_name === "clients") return a.action === "insert" ? `${who}: converted to a client` : a.action === "delete" ? `${who}: client deleted` : `${who}: client details updated`;
    return a.action === "insert" ? `${who}: note added` : a.action === "delete" ? `${who}: note deleted` : `${who}: note edited`;
  }
  const tel = (p: string) => "tel:" + p.replace(/[^0-9+]/g, "");
</script>

<a class="back" href="#/leads">← All leads</a>

{#if lead === undefined}
  <LoadState error={loadError} what="this lead" onretry={() => { loadError = ""; load(); }} />
{:else if lead === null}
  <p class="empty">This lead doesn't exist or was deleted.</p>
{:else}
  {@const l = lead}
  <PageHeader eyebrow={`Lead · since ${shortDate(l.created_at)}`} title={l.company || l.name}>
    {#snippet meta()}
      <p class="contact">
        {#if l.company}<span>{l.name}</span>{/if}
        <a href="mailto:{l.email}">{l.email}</a>
        {#if l.phone}<a href={tel(l.phone)}>{phone(l.phone)}</a>{/if}
      </p>
    {/snippet}
    <div class="headvalue">
      <span class="big num">{money(l.value_monthly)}<small>/mo</small></span>
      <span class="muted num">{money(l.value_one_time)} one time</span>
      <div class="headacts">
        {#if clientFor}
          <a class="btn sm" href="#/clients/{clientFor}">View client →</a>
        {:else}
          <button class="btn sm" class:primary={l.status === "won"} disabled={converting} onclick={convert}>{converting ? "Converting…" : "Convert to client"}</button>
        {/if}
        <button class="btn sm" onclick={toggleArchiveLead}>{l.archived_at ? "Restore lead" : "Archive lead"}</button>
        <Menu label="More actions for this lead" items={[{ label: "Delete lead", danger: true, onselect: deleteLead }]} />
      </div>
    </div>
  </PageHeader>

  {#if lead.archived_at}
    <p class="banner">This lead is archived ({shortDate(lead.archived_at)}). It's hidden from your pipeline and stats.</p>
  {/if}

  <StageButtons label="Stage" options={LEAD_STATUSES} value={lead.status} onpick={setStatus} />

  <div class="cols">
    <div class="main">
      {#each activeQuotes as q (q.id)}
        {@render quoteCard(q)}
      {:else}
        <section class="card"><p class="empty">{archivedQuotes.length ? "All quotes for this lead are archived." : "No quotes for this lead."}</p></section>
      {/each}
      {#if archivedQuotes.length}
        <button class="btn ghost sm toggle" onclick={() => (showArchived = !showArchived)}>
          {showArchived ? "Hide" : "Show"} archived quotes ({archivedQuotes.length})
        </button>
        {#if showArchived}
          {#each archivedQuotes as q (q.id)}{@render quoteCard(q)}{/each}
        {/if}
      {/if}
      {#if clientFor && !projects.length}
        <section class="card">
          <div class="card-head"><h2>Projects</h2></div>
          <p class="muted moved">This lead is a client now, so its projects are on the <a href="#/clients/{clientFor}">client's page</a>.</p>
        </section>
      {:else}
        <ProjectsCard {projects} lines={projectLines} owner={{ lead_id: id, client_id: null }} noun="lead" />
      {/if}
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Notes</h2></div>
        <form onsubmit={addNote}>
          <textarea class="input" placeholder="Call notes, next steps…" maxlength="10000" aria-label="New note" bind:value={draft}></textarea>
          <button class="btn primary sm" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Add note"}</button>
        </form>
        <ul class="notes">
          {#each notes as n (n.id)}
            <li>
              <div><p>{n.body}</p><span class="muted small">{dateTime(n.created_at)}</span></div>
              <button class="iconbtn danger" title="Delete note" aria-label="Delete this note" onclick={() => deleteNote(n)}>×</button>
            </li>
          {/each}
        </ul>
      </section>

      <ActivityCard {activity} {describe} ontoggle={toggleHidden} />
    </aside>
  </div>
{/if}

{#snippet quoteCard(q: Quote)}
  {@const f = itemFilter[q.id] ?? "all"}
  {@const nMo = q.items.filter((i) => i.kind === "monthly").length}
  {@const nOnce = q.items.length - nMo}
  <section class="card quote" class:archived={!!q.archived_at}>
    <div class="card-head">
      <div>
        <h2>Quote · {dateTime(q.created_at)}{#if q.archived_at}<span class="tag">Archived</span>{/if}</h2>
        <p class="sub">{q.workstations} workstations · {q.servers} servers</p>
      </div>
      <div class="qacts">
        <select class="input sel" aria-label="Quote status" value={q.status} onchange={(e) => setQuoteStatus(q, e.currentTarget.value as QuoteStatus)}>
          {#each QUOTE_STATUSES as s (s)}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
        </select>
        {#if !editing[q.id]}<button class="btn sm" onclick={() => (editing[q.id] = true)}>Edit</button>{/if}
        <Menu label="More actions for the quote from {dateTime(q.created_at)}" items={[
          { label: q.archived_at ? "Restore quote" : "Archive quote", onselect: () => toggleArchiveQuote(q) },
          { label: "Delete quote", danger: true, onselect: () => deleteQuote(q) },
        ]} />
      </div>
    </div>
    {#if editing[q.id]}
      <QuoteEditor quote={q} onsave={(ids, ws, sv) => saveServices(q, ids, ws, sv)} oncancel={() => (editing[q.id] = false)} />
    {:else}
    <div class="seg ifilter" role="group" aria-label="Show services">
      <button aria-pressed={f === "all"} onclick={() => (itemFilter[q.id] = "all")}>All <span class="c">{q.items.length}</span></button>
      <button aria-pressed={f === "monthly"} disabled={!nMo} onclick={() => (itemFilter[q.id] = "monthly")}><span class="qdot mo" aria-hidden="true"></span>Monthly <span class="c">{nMo}</span></button>
      <button aria-pressed={f === "once"} disabled={!nOnce} onclick={() => (itemFilter[q.id] = "once")}><span class="qdot once" aria-hidden="true"></span>One time <span class="c">{nOnce}</span></button>
    </div>
    <table class="table">
      <thead><tr><th>Service</th><th>Type</th><th class="r">Price</th></tr></thead>
      <tbody>
        {#each q.items.filter((i) => f === "all" || i.kind === f) as it (it.id)}
          <tr class="irow">
            <td>{it.name}</td>
            <td><span class="kind" class:mo={it.kind === "monthly"}><span class="qdot" class:mo={it.kind === "monthly"} class:once={it.kind !== "monthly"} aria-hidden="true"></span>{it.kind === "monthly" ? "Monthly" : "One time"}</span></td>
            <td class="r num">{it.from ? "from " : ""}{money(it.cost)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="totals">
      <div><span class="muted">Monthly</span><strong class="num">{money(q.monthly_total)}</strong>{#if q.monthly_minimum_applied}<span class="muted small">monthly minimum applied</span>{/if}</div>
      <div><span class="muted">One time</span><strong class="num">{money(q.one_time_total)}</strong></div>
    </div>
    {/if}
    {#if q.message}<blockquote>{q.message}</blockquote>{/if}
  </section>
{/snippet}

<Confirm bind:this={confirm} />

<style>
  .sel { height: var(--control-sm); padding: 0 36px 0 12px; font-size: var(--fs-sm); background-position: right 12px center; }
  /* The dot and its word stay on one line. */
  .kind { display: inline-flex; align-items: center; white-space: nowrap; font-size: var(--fs-xs); color: var(--muted); }
  .kind.mo { color: var(--text-2); }
  .qdot { margin-right: 7px; }
  .quote .card-head { flex-wrap: wrap; }
  .quote .card-head > div:first-child { flex: 1 1 200px; min-width: 0; }
  .small { font-size: var(--fs-xs); }
  blockquote { margin-top: 16px; padding: 12px 14px; border-left: 3px solid var(--lime); background: var(--ink); border-radius: 0 8px 8px 0; color: var(--text-2); font-size: var(--fs-md); white-space: pre-wrap; overflow-wrap: anywhere; }
  form { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
  form textarea { width: 100%; }
  .notes { list-style: none; margin-top: 16px; display: flex; flex-direction: column; }
  .notes li { display: flex; gap: 8px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--line); animation: rise 0.35s var(--ease) both; }
  .notes li > div { flex: 1; min-width: 0; }
  .notes p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-md); }
  /* A note's delete button shows on hover or keyboard focus, and always on touch screens. */
  .notes .iconbtn { opacity: 0; }
  .notes li:hover .iconbtn, .notes .iconbtn:focus-visible { opacity: 1; }
  @media (hover: none) { .notes .iconbtn { opacity: 1; } }
  .ifilter { margin: -4px 0 12px; }
  .ifilter button:disabled { opacity: 0.4; cursor: default; }
  .irow { animation: rise 0.3s var(--ease) both; }
  .qacts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .banner { margin-bottom: 16px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--line-2); color: var(--text-2); font-size: var(--fs-md); }
  /* Archived quotes are marked by the dashed edge and the Archived tag, not by fading the text. */
  .quote.archived { border-style: dashed; }
  .tag { margin-left: 8px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--warning); vertical-align: 2px; }
  .toggle { align-self: flex-start; }
  .moved { font-size: var(--fs-md); }
  .moved a { color: var(--lime); }
  @media (max-width: 640px) {
    .qacts { justify-content: flex-start; width: 100%; }
    .quote .table th, .quote .table td { padding-left: 4px; padding-right: 4px; }
  }
</style>
