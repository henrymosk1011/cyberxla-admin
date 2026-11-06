<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import ReportPill from "../components/ReportPill.svelte";
  import { dateTime } from "../lib/format.ts";
  import { countdown, groupBySend, periodLabel, reportActions, reportState, sendNowText, thisWeek } from "../lib/reports.ts";
  import type { ReportRow, ReportSettings } from "../lib/types.ts";

  let rows = $state<ReportRow[]>([]);
  let settings = $state<ReportSettings | null>(null);
  let loaded = $state(false);
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let now = $state(Date.now());
  let show = $state<"current" | "all">("current");
  let confirm: Confirm;

  async function load() {
    try {
      [rows, settings] = await Promise.all([db.reports(), db.reportSettings()]);
      loaded = true;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load reports.";
    }
  }

  $effect(() => {
    load();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsub = db.subscribeReports(() => {
      clearTimeout(pending);
      pending = setTimeout(load, 300);
    });
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => { unsub(); clearInterval(tick); clearTimeout(pending); };
  });

  const WEEK = 7 * 86400000;
  // Current: anything still to send, tests, and what went out in the last week.
  const visible = $derived(show === "all" ? rows : rows.filter((r) =>
    r.is_test || Date.parse(r.send_at) > now - WEEK || r.status === "scheduled" || r.status === "held" || r.status === "failed" || r.status === "sending"));
  const groups = $derived(groupBySend(visible));
  const week = $derived(thisWeek(rows, now));
  const next = $derived(rows.filter((r) => !r.is_test && r.status === "scheduled" && Date.parse(r.send_at) > now).sort((a, b) => a.send_at.localeCompare(b.send_at))[0]);
  const count = (s: ReportRow["status"]) => rows.filter((r) => !r.is_test && r.status === s && now - Date.parse(r.send_at) <= 86400000).length;
  const needsLook = $derived(rows.filter((r) => !r.is_test && ["failed", "sending"].includes(r.status) && Date.parse(r.send_at) > now - WEEK).length);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  async function act(fn: () => Promise<unknown>, ok: string) {
    error = "";
    notice = "";
    busy = true;
    try {
      await fn();
      notice = ok;
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    } finally {
      busy = false;
      await load();
    }
  }

  const hold = (r: ReportRow) => act(() => db.updateReport(r.id, { status: "held" }), `${r.client_name} is on hold.`);
  const resume = (r: ReportRow) => act(() => db.updateReport(r.id, { status: "scheduled" }), `${r.client_name} will send ${countdown(r.send_at, now)}.`);
  async function sendNow(r: ReportRow) {
    if (!settings) return;
    const ok = await confirm.ask({ title: `Send ${r.client_name} now?`, body: sendNowText(r, settings.mode), action: "Send now" });
    if (ok) await act(() => db.reportAction(r.id, "send_now"), `${r.client_name} is sending. It shows Sent in a minute or two.`);
  }
  async function holdAll() {
    const n = week.toHold.length;
    if (!(await confirm.ask({ title: `Hold ${plural(n, "report", "reports")}?`, body: "Nothing scheduled this week sends until you resume it.", action: "Hold all" }))) return;
    await act(async () => db.moveReports(week.toHold.map((r) => r.id), "scheduled", "held"), `${plural(n, "report is", "reports are")} on hold.`);
  }
  async function resumeAll() {
    const n = week.toResume.length;
    if (!(await confirm.ask({ title: `Resume ${plural(n, "report", "reports")}?`, body: `They send at their scheduled time${settings?.mode === "live" ? ", to clients" : ", to you only (preview mode)"}.`, action: "Resume all" }))) return;
    await act(async () => db.moveReports(week.toResume.map((r) => r.id), "held", "scheduled"), `${plural(n, "report is", "reports are")} scheduled.`);
  }
  const open = (id: string) => (location.hash = `#/reports/${id}`);
</script>

<header class="top">
  <div>
    <p class="eyebrow">Patch reports</p>
    <h1>Reports</h1>
  </div>
  <div class="tools">
    {#if settings}
      <a class="mode" class:live={settings.mode === "live"} href="#/reports/settings">
        {settings.mode === "live" ? "Live: reports go to clients" : "Preview: reports go to you only"}
      </a>
    {/if}
    <a class="btn" href="#/reports/settings">Settings</a>
  </div>
</header>

{#if error}<p class="error banner" role="alert">{error}</p>{/if}
<p class="sr-only" role="status">{notice}</p>
{#if notice}<p class="notice" aria-hidden="true">{notice}</p>{/if}

{#if !loaded}
  <p class="muted">Loading…</p>
{:else}
  <section class="card summary rise">
    <div class="next">
      <p class="eyebrow">Next send</p>
      {#if next}
        <p class="when">{dateTime(next.send_at)}</p>
        <p class="muted">{countdown(next.send_at, now)} · {plural(count("scheduled"), "report scheduled", "reports scheduled")}, {count("held")} on hold</p>
      {:else}
        <p class="when">Nothing scheduled</p>
        <p class="muted">New drafts arrive Sunday at {settings?.generate_time.slice(0, 5) ?? "12:00"} (Pacific).</p>
      {/if}
      {#if needsLook}<p class="warn">{plural(needsLook, "report needs", "reports need")} a look (failed or stuck sending).</p>{/if}
    </div>
    <div class="bulk">
      <button class="btn" disabled={busy || !week.toHold.length} onclick={holdAll}>Hold all this week{week.toHold.length ? ` (${week.toHold.length})` : ""}</button>
      <button class="btn" disabled={busy || !week.toResume.length} onclick={resumeAll}>Resume all{week.toResume.length ? ` (${week.toResume.length})` : ""}</button>
    </div>
  </section>

  <div class="filters">
    <div class="seg" role="group" aria-label="Which reports">
      <button aria-pressed={show === "current"} onclick={() => (show = "current")}>This week</button>
      <button aria-pressed={show === "all"} onclick={() => (show = "all")}>Last 4 months</button>
    </div>
  </div>

  {#each groups as g (g.key)}
    <section class="card flush group">
      <h2 class="ghead">{g.label}</h2>
      <table class="table">
        <thead><tr><th>Client and report</th><th>Status</th><th class="hide-sm">Notes</th><th class="r"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each g.rows as r (r.id)}
            {@const st = reportState(r, now)}
            {@const can = reportActions(r, now)}
            <tr>
              <td class="who">
                <a href="#/reports/{r.id}"><strong>{r.client_name}</strong></a>
                <span class="muted">{periodLabel(r)}</span>
                <span class="gen">Generated {dateTime(r.created_at)}</span>
              </td>
              <td class="st">
                <ReportPill label={st.label} tone={st.tone} test={r.is_test} />
                <span class="stnote">{st.note}</span>
              </td>
              <td class="hide-sm note">
                {#if r.warnings.length}<span class="warn">{r.warnings[0]}</span>{/if}
                {#if r.failure_count}<span>{plural(r.failure_count, "failure", "failures")} in the internal report</span>{/if}
                {#if r.content_version > r.rendered_version && can.edit}<span>Preview updating</span>{/if}
              </td>
              <td class="r acts">
                {#if can.hold}<button class="btn sm" disabled={busy} onclick={() => hold(r)}>Hold<span class="sr-only"> {r.client_name}</span></button>{/if}
                {#if can.resume}<button class="btn sm" disabled={busy} onclick={() => resume(r)}>Resume<span class="sr-only"> {r.client_name}</span></button>{/if}
                {#if can.sendNow}<button class="btn sm" disabled={busy} onclick={() => sendNow(r)}>Send now<span class="sr-only"> {r.client_name}</span></button>{/if}
                <button class="btn sm ghost" onclick={() => open(r.id)}>Open<span class="sr-only"> {r.client_name} {periodLabel(r)}</span></button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {:else}
    <section class="card">
      <p class="empty">
        {rows.length ? "Nothing this week. Switch to Last 4 months to see older reports." : "No reports yet. Turn reports on for a client (on the client's page), and drafts arrive on Sunday."}
      </p>
    </section>
  {/each}
{/if}

<Confirm bind:this={confirm} />

<style>
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin-top: 4px; }
  .tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .mode { font-size: 13px; font-weight: 600; text-decoration: none; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--text-2); }
  .mode.live { border-color: var(--lime); color: var(--lime); }
  .mode:hover { color: var(--text); }
  .banner { margin-bottom: 16px; }
  .notice { margin-bottom: 16px; font-size: 14px; color: var(--good-text); }
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .next { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .when { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .next .muted { font-size: 14px; }
  .warn { color: var(--warning); font-size: 13px; }
  .bulk { display: flex; gap: 8px; flex-wrap: wrap; }
  .filters { margin-bottom: 16px; }
  .group { margin-bottom: 16px; }
  .flush { padding: 8px 8px 0; }
  .ghead { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: var(--text-2); padding: 10px 12px 12px; }
  .group .table { table-layout: fixed; }
  .group th:nth-child(1) { width: 24%; }
  .group th:nth-child(2) { width: 30%; }
  .group th:nth-child(4) { width: 270px; }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .who a { text-decoration: none; }
  .who a:hover strong { text-decoration: underline; }
  .who .muted { font-size: 13px; }
  .gen { font-size: 12px; color: var(--muted); }
  .st { min-width: 0; }
  .stnote { display: block; margin-top: 4px; font-size: 13px; color: var(--text-2); max-width: 360px; }
  .note { font-size: 13px; color: var(--text-2); max-width: 320px; }
  .note span { display: block; }
  .acts { white-space: nowrap; text-align: right; }
  .acts .btn { margin-left: 4px; }
  @media (max-width: 860px) {
    .top { flex-direction: column; align-items: stretch; }
  }
  @media (max-width: 720px) { .hide-sm { display: none; } }
  @media (max-width: 640px) {
    .flush { padding: 4px; }
    .table thead { display: none; }
    .table, .table tbody { display: block; }
    .table tbody tr { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px 12px; padding: 14px 12px; border-bottom: 1px solid var(--line); }
    .table tbody tr:last-child { border-bottom: 0; }
    .table td { display: block; padding: 0; border: 0; }
    .table td.hide-sm { display: none; }
    .st { grid-column: 1 / -1; }
    .acts { grid-column: 1 / -1; white-space: normal; display: flex; flex-wrap: wrap; gap: 6px; }
    .acts .btn { margin-left: 0; }
  }
</style>
