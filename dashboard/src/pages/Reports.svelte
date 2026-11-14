<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import ReportPill from "../components/ReportPill.svelte";
  import { dateTime } from "../lib/format.ts";
  import { countdown, periodLabel, reportActions, reportState, sendNowText, sortReports, thisWeek, type ReportSortKey, type SortDir } from "../lib/reports.ts";
  import type { ReportRow, ReportSettings } from "../lib/types.ts";

  let rows = $state<ReportRow[]>([]);
  let settings = $state<ReportSettings | null>(null);
  let loaded = $state(false);
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let now = $state(Date.now());
  let show = $state<"current" | "all" | "cleared">("current");

  // Sorting: newest send date first unless you pick another column. Remembered
  // in this browser only (a convenience; it falls back to the default).
  const COLUMNS: { key: ReportSortKey; label: string; first: SortDir }[] = [
    { key: "client", label: "Client", first: "asc" },
    { key: "report", label: "Report", first: "desc" },
    { key: "status", label: "Status", first: "asc" },
    { key: "sends", label: "Sends", first: "desc" },
    { key: "generated", label: "Generated", first: "desc" },
  ];
  const DEFAULT_SORT = { key: "sends" as ReportSortKey, dir: "desc" as SortDir };
  function savedSort() {
    try {
      const v = JSON.parse(localStorage.getItem("reports.sort") || "null");
      if (v && COLUMNS.some((c) => c.key === v.key) && (v.dir === "asc" || v.dir === "desc")) return v as typeof DEFAULT_SORT;
    } catch { /* storage off or unreadable: use the default */ }
    return DEFAULT_SORT;
  }
  let sort = $state(savedSort());
  function sortBy(key: ReportSortKey, dir?: SortDir) {
    const col = COLUMNS.find((c) => c.key === key)!;
    sort = { key, dir: dir ?? (sort.key === key ? (sort.dir === "asc" ? "desc" : "asc") : col.first) };
    try { localStorage.setItem("reports.sort", JSON.stringify(sort)); } catch { /* not saved; fine */ }
  }
  const ariaSort = (key: ReportSortKey) => (sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined);
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
  // Cleared reports are off the list (kept) until you open the Cleared view.
  const listed = $derived(rows.filter((r) => !r.cleared_at));
  const cleared = $derived(rows.filter((r) => r.cleared_at));
  // Current: anything still to send, tests, and what went out in the last week.
  const visible = $derived(show === "cleared" ? cleared : show === "all" ? listed : listed.filter((r) =>
    r.is_test || Date.parse(r.send_at) > now - WEEK || r.status === "scheduled" || r.status === "held" || r.status === "failed" || r.status === "sending"));
  // Test reports Clear test reports would take off the list.
  const clearableTests = $derived(listed.filter((r) => r.is_test && r.status !== "sending"));
  const sorted = $derived(sortReports(visible, sort.key, sort.dir));

  // Ticked rows, for Clear selected (or Restore selected and Delete selected in the Cleared view).
  // Only rows that can be cleared (or restored) get a checkbox.
  let picked = $state<string[]>([]);
  const canPick = (r: ReportRow) => (show === "cleared" ? !!r.cleared_at : reportActions(r, now).clear);
  const pickable = $derived(sorted.filter(canPick));
  // Keep only ticks that are still on screen and still allowed.
  $effect(() => {
    const ok = new Set(pickable.map((r) => r.id));
    if (picked.some((id) => !ok.has(id))) picked = picked.filter((id) => ok.has(id));
  });
  const allPicked = $derived(pickable.length > 0 && pickable.every((r) => picked.includes(r.id)));
  const somePicked = $derived(picked.length > 0 && !allPicked);
  const togglePick = (id: string, on: boolean) => (picked = on ? [...new Set([...picked, id])] : picked.filter((x) => x !== id));
  const toggleAll = (on: boolean) => (picked = on ? pickable.map((r) => r.id) : []);
  function setShow(v: typeof show) {
    show = v;
    picked = [];
  }
  const week = $derived(thisWeek(rows, now));
  const next = $derived(rows.filter((r) => !r.is_test && r.status === "scheduled" && Date.parse(r.send_at) > now).sort((a, b) => a.send_at.localeCompare(b.send_at))[0]);
  const count = (s: ReportRow["status"]) => rows.filter((r) => !r.is_test && r.status === s && now - Date.parse(r.send_at) <= 86400000).length;
  const needsLook = $derived(listed.filter((r) => !r.is_test && ["failed", "sending"].includes(r.status) && Date.parse(r.send_at) > now - WEEK).length);
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
  async function clearPicked() {
    const ids = [...picked];
    const n = ids.length;
    if (!n) return;
    if (show === "cleared") {
      await act(() => db.clearReports(ids, false), `${plural(n, "report is", "reports are")} back on the list.`);
    } else {
      if (!(await confirm.ask({ title: `Clear ${plural(n, "report", "reports")}?`, body: "They leave the list now. Nothing is deleted: find them under Cleared, where Restore brings them back.", action: "Clear" }))) return;
      await act(() => db.clearReports(ids, true), `${plural(n, "report is", "reports are")} cleared. Find them under Cleared.`);
    }
    picked = [];
  }
  // Delete for good, from the Cleared view: the reports and their PDFs go.
  const deleteText = (n: number) => `This removes ${n === 1 ? "the report and its PDFs" : "the reports and their PDFs"} for good. It can't be undone. The record in Activity stays.`;
  async function deletePicked() {
    const ids = picked.filter((id) => { const r = rows.find((x) => x.id === id); return r && reportActions(r, now).remove; });
    const n = ids.length;
    if (!n) return;
    if (!(await confirm.ask({ title: `Delete ${plural(n, "report", "reports")} for good?`, body: deleteText(n), action: "Delete", danger: true }))) return;
    await act(() => db.deleteReports(ids), `${plural(n, "report is", "reports are")} deleted.`);
    picked = [];
  }
  async function deleteOne(r: ReportRow) {
    if (!(await confirm.ask({ title: `Delete ${r.client_name}, ${periodLabel(r)} for good?`, body: deleteText(1), action: "Delete", danger: true }))) return;
    await act(() => db.deleteReports([r.id]), `${r.client_name}, ${periodLabel(r)} is deleted.`);
  }
  const clear = (r: ReportRow) => act(() => db.clearReports([r.id], true), `${r.client_name}, ${periodLabel(r)} is cleared from the list. Find it under Cleared.`);
  const restore = (r: ReportRow) => act(() => db.clearReports([r.id], false), `${r.client_name}, ${periodLabel(r)} is back on the list.`);
  async function clearTests() {
    const n = clearableTests.length;
    if (!(await confirm.ask({ title: `Clear ${plural(n, "test report", "test reports")}?`, body: "They leave the list now (find them under Cleared). Test reports delete themselves a week after they're made.", action: "Clear" }))) return;
    await act(() => db.clearReports(clearableTests.map((r) => r.id), true), `${plural(n, "test report is", "test reports are")} cleared.`);
  }
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
    <a class="btn" href="#/reports/template">Template</a>
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
      <button class="btn ghost" disabled={busy || !clearableTests.length} onclick={clearTests}>Clear test reports{clearableTests.length ? ` (${clearableTests.length})` : ""}</button>
    </div>
  </section>

  <div class="filters">
    <div class="seg" role="group" aria-label="Which reports">
      <button aria-pressed={show === "current"} onclick={() => setShow("current")}>This week</button>
      <button aria-pressed={show === "all"} onclick={() => setShow("all")}>Last 4 months</button>
      <button aria-pressed={show === "cleared"} onclick={() => setShow("cleared")}>Cleared{cleared.length ? ` (${cleared.length})` : ""}</button>
    </div>
  </div>

  {#if sorted.length}
    <section class="card flush list">
      {#if picked.length}
        <div class="picked" role="region" aria-label="Selected reports">
          <span>{plural(picked.length, "report", "reports")} selected</span>
          <div>
            <button type="button" class="btn sm primary" disabled={busy} onclick={clearPicked}>{show === "cleared" ? "Restore selected" : "Clear selected"}</button>
            {#if show === "cleared"}<button type="button" class="btn sm ghost del" disabled={busy} onclick={deletePicked}>Delete selected</button>{/if}
            <button type="button" class="btn sm ghost" onclick={() => (picked = [])}>Unselect all</button>
          </div>
        </div>
      {/if}
      <div class="phone-sort">
        {#if pickable.length}
          <!-- Phones hide the table header, so its select all box lives here. -->
          <label class="selall"><input type="checkbox" checked={allPicked} indeterminate={somePicked} onchange={(e) => toggleAll(e.currentTarget.checked)} /> Select all</label>
        {/if}
        <label for="sort-key">Sort by</label>
        <select id="sort-key" class="input" value={sort.key} onchange={(e) => sortBy(e.currentTarget.value as ReportSortKey, COLUMNS.find((c) => c.key === e.currentTarget.value)!.first)}>
          {#each COLUMNS as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
        </select>
        <button type="button" class="btn sm" onclick={() => sortBy(sort.key, sort.dir === "asc" ? "desc" : "asc")}>{sort.dir === "asc" ? "Oldest or A to Z first" : "Newest or Z to A first"}</button>
      </div>
      <table class="table">
        <caption class="sr-only">Reports, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}, {sort.dir === "asc" ? "ascending" : "descending"}. Column headings sort the table.</caption>
        <thead>
          <tr>
            <th class="pick">
              {#if pickable.length}
                <input type="checkbox" checked={allPicked} indeterminate={somePicked} onchange={(e) => toggleAll(e.currentTarget.checked)}
                  aria-label={show === "cleared" ? "Select every cleared report" : "Select every report that can be cleared"} />
              {/if}
            </th>
            {#each COLUMNS as c (c.key)}
              <th aria-sort={ariaSort(c.key)} class:hide-md={c.key === "generated"}>
                <button type="button" class="sort" class:on={sort.key === c.key} onclick={() => sortBy(c.key)}>
                  {c.label}<span class="arrow" aria-hidden="true">{sort.key === c.key ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
                </button>
              </th>
            {/each}
            <th class="r"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each sorted as r (r.id)}
            {@const st = reportState(r, now)}
            {@const can = reportActions(r, now)}
            <tr class:on={picked.includes(r.id)}>
              <td class="pick">
                {#if canPick(r)}
                  <input type="checkbox" checked={picked.includes(r.id)} onchange={(e) => togglePick(r.id, e.currentTarget.checked)} aria-label="Select {r.client_name}, {periodLabel(r)}{r.is_test ? ' (test)' : ''}" />
                {/if}
              </td>
              <td class="who"><a href="#/reports/{r.id}"><strong>{r.client_name}</strong></a></td>
              <td class="rep">{periodLabel(r)}</td>
              <td class="st">
                <ReportPill label={st.label} tone={st.tone} test={r.is_test} />
                <!-- The full explanation is on the report; here only what needs you. -->
                {#if st.tone === "bad"}<span class="stnote">{st.note}</span>{/if}
                {#if r.warnings.length}<span class="stnote warn">{r.warnings[0]}</span>{/if}
                {#if r.failure_count}<span class="stnote">{plural(r.failure_count, "failure", "failures")} to check</span>{/if}
                {#if r.content_version > r.rendered_version && can.edit}<span class="stnote">Preview updating</span>{/if}
              </td>
              <td class="when-cell"><span class="lbl" aria-hidden="true">Sends </span>{dateTime(r.send_at)}</td>
              <td class="hide-md gen">{dateTime(r.created_at)}</td>
              <td class="r acts">
                {#if can.hold}<button class="btn sm" disabled={busy} onclick={() => hold(r)}>Hold<span class="sr-only"> {r.client_name}</span></button>{/if}
                {#if can.resume}<button class="btn sm" disabled={busy} onclick={() => resume(r)}>Resume<span class="sr-only"> {r.client_name}</span></button>{/if}
                {#if can.sendNow}<button class="btn sm" disabled={busy} onclick={() => sendNow(r)}>Send now<span class="sr-only"> {r.client_name}</span></button>{/if}
                {#if can.clear}<button class="btn sm ghost" disabled={busy} onclick={() => clear(r)}>Clear<span class="sr-only"> {r.client_name} {periodLabel(r)} from the list</span></button>{/if}
                {#if can.restore}<button class="btn sm" disabled={busy} onclick={() => restore(r)}>Restore<span class="sr-only"> {r.client_name} {periodLabel(r)} to the list</span></button>{/if}
                {#if show === "cleared" && can.remove}<button class="btn sm ghost del" disabled={busy} onclick={() => deleteOne(r)}>Delete<span class="sr-only"> {r.client_name} {periodLabel(r)} for good</span></button>{/if}
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
        {show === "cleared" ? "Nothing cleared. Clear a finished report (sent, failed, cancelled or a test) to take it off the list." : rows.length ? "Nothing this week. Switch to Last 4 months to see older reports." : "No reports yet. Turn reports on for a client (on the client's page), and drafts arrive on Sunday."}
      </p>
    </section>
  {/if}
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
  /* A little lighter than --critical so it stays readable on a ticked row's tint (4.5:1). */
  .del { color: color-mix(in srgb, var(--critical) 85%, white); }
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .next { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .when { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .next .muted { font-size: 14px; }
  .warn { color: var(--warning); font-size: 13px; }
  .bulk { display: flex; gap: 8px; flex-wrap: wrap; }
  .filters { margin-bottom: 16px; }
  .list { margin-bottom: 16px; }
  .flush { padding: 8px 8px 0; }
  .list .table { table-layout: fixed; }
  .list th:nth-child(1) { width: 44px; }
  .list th:nth-child(2) { width: 16%; }
  .list th:nth-child(3) { width: 16%; }
  .list th:nth-child(4) { width: auto; }
  .list th:nth-child(5) { width: 14%; }
  .list th:nth-child(6) { width: 13%; }
  .list th:nth-child(7) { width: 250px; }
  .pick input { width: 18px; height: 18px; accent-color: var(--lime); cursor: pointer; vertical-align: middle; }
  .list tbody tr.on { background: color-mix(in srgb, var(--lime) 7%, transparent); }
  .picked {
    position: sticky; top: 8px; z-index: 5; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 12px;
    margin: 4px 4px 8px; padding: 10px 12px; border: 1px solid var(--lime); border-radius: 10px; background: var(--surface-2); font-size: 14px; font-weight: 600;
  }
  .picked div { display: flex; gap: 8px; flex-wrap: wrap; }
  th .sort {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; margin: -4px -6px; border: 0; border-radius: 6px;
    background: none; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer;
  }
  th .sort:hover { color: var(--text); background: var(--surface-2); }
  th .sort.on { color: var(--text); }
  .arrow { font-size: 12px; color: var(--muted); }
  .sort.on .arrow { color: var(--lime); }
  .who { min-width: 0; }
  .who a { text-decoration: none; }
  .who a:hover strong { text-decoration: underline; }
  .rep { font-size: 14px; color: var(--text-2); }
  .gen, .when-cell { font-size: 13px; color: var(--text-2); }
  .when-cell .lbl { display: none; }
  .st { min-width: 0; }
  .stnote { display: block; margin-top: 4px; font-size: 13px; color: var(--text-2); }
  .stnote.warn { color: var(--warning); }
  .phone-sort { display: none; }
  .acts { white-space: nowrap; text-align: right; }
  .acts .btn { margin-left: 4px; }
  @media (max-width: 860px) {
    .top { flex-direction: column; align-items: stretch; }
  }
  @media (max-width: 1100px) { .hide-md { display: none; } }
  @media (max-width: 640px) {
    .flush { padding: 4px; }
    .table thead { display: none; }
    .table, .table tbody { display: block; }
    .table tbody tr { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px 12px; padding: 14px 12px; border-bottom: 1px solid var(--line); }
    .table td.pick { grid-column: 1; }
    .table td.who { grid-column: 2; }
    .table tbody tr:last-child { border-bottom: 0; }
    .table td { display: block; padding: 0; border: 0; }
    .table td.hide-md { display: none; }
    .st, .rep, .when-cell { grid-column: 1 / -1; }
    .when-cell .lbl { display: inline; }
    .phone-sort { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 8px 12px; border-bottom: 1px solid var(--line); }
    .phone-sort label { font-size: 13px; color: var(--text-2); }
    .phone-sort .selall { display: inline-flex; align-items: center; gap: 8px; margin-right: auto; }
    .phone-sort .selall input { width: 18px; height: 18px; accent-color: var(--lime); }
    .phone-sort .input { height: 36px; width: auto; }
    .acts { grid-column: 1 / -1; white-space: normal; display: flex; flex-wrap: wrap; gap: 6px; }
    .acts .btn { margin-left: 0; }
  }
</style>
