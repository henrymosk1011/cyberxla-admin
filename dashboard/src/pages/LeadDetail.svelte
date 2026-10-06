<script lang="ts">
  import db from "$db";
  import StatusPill from "../components/StatusPill.svelte";
  import { dateTime, money, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { LEAD_STATUSES, QUOTE_STATUSES, type AuditEntry, type Lead, type LeadStatus, type Note, type Quote, type QuoteStatus } from "../lib/types.ts";

  let { id, version, onstatus }: { id: string; version: number; onstatus: (id: string, s: LeadStatus) => Promise<void> } = $props();

  let lead = $state<Lead | null | undefined>(undefined);
  let quotes = $state<Quote[]>([]);
  let notes = $state<Note[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let draft = $state("");
  let saving = $state(false);
  let error = $state("");

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
    if (a.table_name === "leads") {
      if (a.action === "insert") return `${who}: lead created`;
      if (a.action === "update" && n.status !== o.status) return `${who}: stage ${STATUS_LABEL[String(o.status)] ?? o.status} → ${STATUS_LABEL[String(n.status)] ?? n.status}`;
      if (a.action === "update") return `${who}: lead details updated`;
      return `${who}: lead deleted`;
    }
    if (a.table_name === "quotes") {
      if (a.action === "insert") return `${who}: quote received (${money(Number(n.monthly_total ?? 0))}/mo)`;
      if (a.action === "update" && n.status !== o.status) return `${who}: quote ${STATUS_LABEL[String(n.status)]?.toLowerCase() ?? n.status}`;
      return `${who}: quote updated`;
    }
    return a.action === "insert" ? `${who}: note added` : `${who}: note ${a.action}d`;
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
        {#if lead.phone}<a href={tel(lead.phone)}>{lead.phone}</a>{/if}
      </p>
    </div>
    <div class="value">
      <span class="big num">{money(lead.value_monthly)}<small>/mo</small></span>
      <span class="muted num">{money(lead.value_one_time)} one time</span>
    </div>
  </header>

  <div class="stages" role="group" aria-label="Stage">
    {#each LEAD_STATUSES as s (s)}
      <button class="stage st-{s}" aria-pressed={lead.status === s} onclick={() => setStatus(s)}><i aria-hidden="true"></i>{STATUS_LABEL[s]}</button>
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="cols">
    <div class="main">
      {#each quotes as q (q.id)}
        <section class="card quote">
          <div class="card-head">
            <div>
              <h2>Quote · {dateTime(q.created_at)}</h2>
              <p class="sub">{q.workstations} workstations · {q.servers} servers</p>
            </div>
            <select class="input sel" aria-label="Quote status" value={q.status} onchange={(e) => setQuoteStatus(q, e.currentTarget.value as QuoteStatus)}>
              {#each QUOTE_STATUSES as s (s)}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
            </select>
          </div>
          <table class="table">
            <thead><tr><th>Service</th><th>Type</th><th class="r">Price</th></tr></thead>
            <tbody>
              {#each q.items as it (it.id)}
                <tr>
                  <td>{it.name}</td>
                  <td><span class="kind" class:mo={it.kind === "monthly"}>{it.kind === "monthly" ? "Monthly" : "One time"}</span></td>
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
      {:else}
        <section class="card"><p class="empty">No quotes for this lead.</p></section>
      {/each}
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
            <li><p>{n.body}</p><span class="muted small">{dateTime(n.created_at)}</span></li>
          {/each}
        </ul>
      </section>

      <section class="card">
        <div class="card-head"><h2>Activity</h2></div>
        <ol class="timeline">
          {#each activity as a (a.id)}
            <li><span class="dot" aria-hidden="true"></span><div><p>{describe(a)}</p><span class="muted small">{dateTime(a.at)}</span></div></li>
          {:else}
            <li class="muted">No activity yet.</li>
          {/each}
        </ol>
      </section>
    </aside>
  </div>
{/if}

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
  .sel { height: 34px; padding: 0 10px; font-size: 13px; }
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
  .notes li { padding: 12px 0; border-top: 1px solid var(--line); }
  .notes p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .timeline { list-style: none; display: flex; flex-direction: column; gap: 14px; }
  .timeline li { display: flex; gap: 12px; font-size: 13px; }
  .timeline .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--axis); flex: none; }
  .timeline li:first-child .dot { background: var(--lime); }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } .value { align-items: flex-start; } }
</style>
