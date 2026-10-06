<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import { dateTime, money, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { LEAD_STATUSES, QUOTE_STATUSES, type AuditEntry, type Lead, type LeadStatus, type Note, type Quote, type QuoteStatus } from "../lib/types.ts";

  let { id, version, onstatus }: { id: string; version: number; onstatus: (id: string, s: LeadStatus) => Promise<void> } = $props();

  let lead = $state<Lead | null | undefined>(undefined);
  let quotes = $state<Quote[]>([]);
  let notes = $state<Note[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let draft = $state("");
  let saving = $state(false);
  let error = $state("");
  let showArchived = $state(false);
  let showHidden = $state(false);
  // Per-quote line item filter, like the quote builder's.
  let itemFilter = $state<Record<string, "all" | "monthly" | "once">>({});
  let confirm: Confirm;

  const activeQuotes = $derived(quotes.filter((q) => !q.archived_at));
  const archivedQuotes = $derived(quotes.filter((q) => q.archived_at));
  const visibleActivity = $derived(activity.filter((a) => showHidden || !a.hidden));
  const hiddenCount = $derived(activity.filter((a) => a.hidden).length);

  async function run(fn: () => Promise<void>, failMsg: string) {
    error = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : failMsg;
    }
    await load();
  }

  async function toggleArchiveLead() {
    if (!lead) return;
    const archiving = !lead.archived_at;
    if (archiving && !(await confirm.ask({ title: "Archive this lead?", body: "It leaves your pipeline, board, and stats, but nothing is deleted. You can restore it any time from Leads → Archived.", action: "Archive" }))) return;
    await run(() => db.archiveLead(id, archiving), "Couldn't update the lead.");
  }
  async function deleteLead() {
    if (!lead) return;
    const name = lead.company || lead.name;
    if (!(await confirm.ask({ title: `Delete ${name}?`, body: "This permanently deletes the lead, all of its quotes, and its notes. This can't be undone. (Archive instead if you might need it later.)", action: "Delete permanently", danger: true }))) return;
    error = "";
    try {
      await db.deleteLead(id);
      location.hash = "#/leads";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't delete the lead.";
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
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load this lead.";
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
    q.status = s;
    await db.setQuoteStatus(q.id, s);
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
      error = err instanceof Error ? err.message : "Couldn't save the note.";
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
      return `${who}: quote updated`;
    }
    return a.action === "insert" ? `${who}: note added` : a.action === "delete" ? `${who}: note deleted` : `${who}: note edited`;
  }
  const tel = (p: string) => "tel:" + p.replace(/[^0-9+]/g, "");
</script>

<a class="back" href="#/leads">← All leads</a>

{#if lead === undefined}
  <p class="muted">Loading…</p>
{:else if lead === null}
  <p class="empty">{error || "This lead doesn't exist or was deleted."}</p>
{:else}
  <header class="head">
    <div class="id">
      <p class="eyebrow">Lead · since {shortDate(lead.created_at)}</p>
      <h1>{lead.company || lead.name}</h1>
      <p class="contact">
        {#if lead.company}<span>{lead.name}</span>{/if}
        <a href="mailto:{lead.email}">{lead.email}</a>
        {#if lead.phone}<a href={tel(lead.phone)}>{phone(lead.phone)}</a>{/if}
      </p>
    </div>
    <div class="value">
      <span class="big num">{money(lead.value_monthly)}<small>/mo</small></span>
      <span class="muted num">{money(lead.value_one_time)} one time</span>
      <div class="acts">
        <button class="btn sm" onclick={toggleArchiveLead}>{lead.archived_at ? "Restore lead" : "Archive lead"}</button>
        <button class="btn sm ghost del" onclick={deleteLead}>Delete lead</button>
      </div>
    </div>
  </header>

  {#if lead.archived_at}
    <p class="banner">This lead is archived ({shortDate(lead.archived_at)}). It's hidden from your pipeline and stats.</p>
  {/if}

  <div class="stages" role="group" aria-label="Stage">
    {#each LEAD_STATUSES as s (s)}
      <button class="stage st-{s}" aria-pressed={lead.status === s} onclick={() => setStatus(s)}><i aria-hidden="true"></i>{STATUS_LABEL[s]}</button>
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

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
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Notes</h2></div>
        <form onsubmit={addNote}>
          <textarea class="input" placeholder="Call notes, next steps…" maxlength="10000" bind:value={draft}></textarea>
          <button class="btn primary sm" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Add note"}</button>
        </form>
        <ul class="notes">
          {#each notes as n (n.id)}
            <li>
              <div><p>{n.body}</p><span class="muted small">{dateTime(n.created_at)}</span></div>
              <button class="x" title="Delete note" aria-label="Delete this note" onclick={() => deleteNote(n)}>×</button>
            </li>
          {/each}
        </ul>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Activity</h2>
          {#if hiddenCount}
            <button class="btn ghost sm" onclick={() => (showHidden = !showHidden)}>{showHidden ? "Hide" : "Show"} removed ({hiddenCount})</button>
          {/if}
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
        <button class="btn sm" onclick={() => toggleArchiveQuote(q)}>{q.archived_at ? "Restore" : "Archive"}</button>
        <button class="btn sm ghost del" onclick={() => deleteQuote(q)}>Delete</button>
      </div>
    </div>
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
    {#if q.message}<blockquote>{q.message}</blockquote>{/if}
  </section>
{/snippet}

<Confirm bind:this={confirm} />

<style>
  .back { display: inline-block; font-size: 13px; color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 34px; letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 8px; overflow-wrap: anywhere; }
  .contact { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; color: var(--text-2); }
  .contact a { color: var(--lime); text-decoration: none; overflow-wrap: anywhere; }
  .contact a:hover { text-decoration: underline; }
  .value { display: flex; flex-direction: column; align-items: flex-end; }
  .big { font-size: 32px; font-weight: 650; letter-spacing: -0.03em; color: var(--lime); }
  .big small { font-size: 16px; color: var(--muted); }
  .stages { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface); color: var(--text-2); font-size: 13px; font-weight: 600; }
  .stage:hover { background: var(--surface-2); color: var(--text); }
  .stage[aria-pressed="true"] { background: var(--surface-3); color: var(--text); border-color: var(--text-2); }
  .stage i { width: 8px; height: 8px; border-radius: 50%; }
  .st-new i { background: var(--st-new); } .st-contacted i { background: var(--st-contacted); } .st-proposal i { background: var(--st-proposal); }
  .st-won i { background: var(--st-won); } .st-lost i { background: var(--st-lost); }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
  .main, .side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .sel { height: 34px; padding: 0 36px 0 12px; font-size: 13px; background-position: right 12px center; }
  .kind { font-size: 12px; color: var(--muted); }
  .kind.mo { color: var(--text-2); }
  .totals { display: flex; gap: 32px; padding: 16px 12px 4px; border-top: 1px solid var(--line-2); margin-top: 4px; }
  .totals div { display: flex; flex-direction: column; }
  .totals strong { font-size: 20px; font-weight: 650; }
  .small { font-size: 12px; }
  blockquote { margin-top: 16px; padding: 12px 14px; border-left: 3px solid var(--lime); background: var(--ink); border-radius: 0 8px 8px 0; color: var(--text-2); font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  form { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
  form textarea { width: 100%; }
  .notes { list-style: none; margin-top: 16px; display: flex; flex-direction: column; }
  .notes li { display: flex; gap: 8px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--line); animation: rise 0.35s var(--ease) both; }
  .notes li > div { flex: 1; min-width: 0; }
  .notes .x, .timeline .x { border: 0; background: none; color: var(--muted); font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; }
  .notes li:hover .x, .notes .x:focus-visible { opacity: 1; }
  .notes .x:hover { color: var(--critical); background: var(--surface-2); }
  .ifilter { margin: -4px 0 12px; }
  .ifilter .c { color: var(--muted); font-weight: 500; margin-left: 2px; }
  .ifilter button:disabled { opacity: 0.4; cursor: default; }
  .qdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; }
  .qdot.mo { background: var(--lime); box-shadow: 0 0 6px rgba(214, 255, 63, 0.4); }
  .qdot.once { border: 1.5px solid var(--muted); }
  .irow { animation: rise 0.3s var(--ease) both; }
  .notes p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .timeline { list-style: none; display: flex; flex-direction: column; gap: 14px; }
  .timeline li { display: flex; gap: 12px; font-size: 13px; align-items: flex-start; }
  .timeline li > div { flex: 1; min-width: 0; }
  .timeline li:hover .x, .timeline .x:focus-visible { opacity: 1; }
  .timeline .x:hover { color: var(--text); background: var(--surface-2); }
  .timeline li.hidden-entry { opacity: 0.5; }
  .timeline li.hidden-entry .x { opacity: 1; }
  @media (hover: none) { .timeline .x, .notes .x { opacity: 1; } }
  .acts { display: flex; gap: 6px; margin-top: 10px; }
  .qacts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .del { color: var(--critical); }
  .del:hover { color: #ff9a9a; }
  .banner { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line-2); color: var(--text-2); font-size: 14px; }
  .quote.archived { opacity: 0.7; border-style: dashed; }
  .tag { margin-left: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--warning); vertical-align: 2px; }
  .toggle { align-self: flex-start; }
  .timeline .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--axis); flex: none; }
  .timeline li:first-child .dot { background: var(--lime); }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } .value { align-items: flex-start; } }
</style>
