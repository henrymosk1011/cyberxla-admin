<script lang="ts">
  // Patch reports for one client: their Action1 group, who gets the reports,
  // whether they are on, computers to always leave off, and recent reports.
  import db from "$db";
  import ReportPill from "./ReportPill.svelte";
  import { parseEmails, parseNames, periodLabel, reportState } from "../lib/reports.ts";
  import type { Client, ReportRow } from "../lib/types.ts";

  let { client, onsaved }: { client: Client; onsaved: () => void } = $props();

  // Until migration 0010 runs these columns don't exist; show the card empty instead of breaking the page.
  const to0 = $derived((client.report_recipients ?? []).join(", "));
  const cc0 = $derived((client.report_cc ?? []).join(", "));
  const off0 = $derived((client.report_exclude ?? []).join("\n"));

  let form = $state({ group: "", to: "", cc: "", enabled: false, off: "" });
  let reports = $state<ReportRow[]>([]);
  let error = $state("");
  let saved = $state("");
  let busy = $state(false);

  // Reset the form only when these saved values change, not every time the
  // client page reloads (saving notes elsewhere shouldn't wipe edits here).
  const savedKey = $derived(JSON.stringify([client.id, client.action1_group, to0, cc0, client.reports_enabled, off0]));
  $effect(() => {
    void savedKey;
    form = { group: client.action1_group ?? "", to: to0, cc: cc0, enabled: !!client.reports_enabled, off: off0 };
  });
  $effect(() => {
    const id = client.id;
    db.reports().then((r) => (reports = r.filter((x) => x.client_id === id && !x.is_test).slice(0, 5)), () => {});
  });

  const dirty = $derived(form.group !== (client.action1_group ?? "") || form.to !== to0 || form.cc !== cc0
    || form.enabled !== !!client.reports_enabled || parseNames(form.off).join("\n") !== off0);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    const to = parseEmails(form.to), cc = parseEmails(form.cc);
    if (to.invalid.length || cc.invalid.length) return (error = `These don't look like email addresses: ${[...to.invalid, ...cc.invalid].join(", ")}`);
    if (to.emails.length > 10 || cc.emails.length > 10) return (error = "Up to 10 recipients and 10 cc.");
    const off = parseNames(form.off);
    if (off.length > 200 || off.some((n) => n.length > 120)) return (error = "Up to 200 computers, each name up to 120 characters.");
    const group = form.group.trim();
    if (form.enabled && (!group || !to.emails.length)) return (error = "To turn reports on, add the Action1 group and at least one recipient.");
    busy = true;
    try {
      await db.updateClient(client.id, { action1_group: group || null, report_recipients: to.emails, report_cc: cc.emails, reports_enabled: form.enabled, report_exclude: off });
      saved = "Saved";
      setTimeout(() => (saved = ""), 2000);
      onsaved();
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      error = /taken/.test(m) ? "Another client already uses that Action1 group." : m || "Couldn't save.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="card">
  <div class="card-head"><h2>Patch reports</h2>{#if saved}<span class="ok" role="status">✓ {saved}</span>{/if}</div>
  <form class="form" onsubmit={save}>
    <label class="check"><input type="checkbox" bind:checked={form.enabled} /> Send weekly and monthly reports</label>
    <div class="field"><label for="r-group">Action1 group</label><input id="r-group" class="input" maxlength="80" autocomplete="off" bind:value={form.group} aria-describedby="r-group-h" /><span id="r-group-h" class="hint">Exactly as named in Action1.</span></div>
    <div class="field"><label for="r-to">Send to</label><input id="r-to" class="input" autocomplete="off" bind:value={form.to} aria-describedby="r-to-h" /><span id="r-to-h" class="hint">Separate addresses with commas.</span></div>
    <div class="field"><label for="r-cc">Cc</label><input id="r-cc" class="input" autocomplete="off" bind:value={form.cc} /></div>
    <div class="field">
      <label for="r-off">Always leave off these computers</label>
      <textarea id="r-off" class="input" rows="3" autocomplete="off" placeholder="One name per line" bind:value={form.off} aria-describedby="r-off-h"></textarea>
      <span id="r-off-h" class="hint">Names as they show on the report, for example Front Desk. They're left out of every future report for this client, numbers included.</span>
    </div>
    <p class="hint">Changes apply to reports made after you save. Reports already made keep their recipients (edit those on the report).</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row"><button class="btn primary sm" disabled={!dirty || busy}>Save</button></div>
  </form>
  {#if reports.length}
    <ul class="recent">
      {#each reports as r (r.id)}
        {@const st = reportState(r)}
        <li><a href="#/reports/{r.id}">{periodLabel(r)}</a> <ReportPill label={st.label} tone={st.tone} /></li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .form { display: flex; flex-direction: column; gap: 10px; }
  .form .input { height: 38px; width: 100%; min-width: 0; }
  .form textarea.input { height: auto; min-height: 76px; }
  .field { min-width: 0; }
  .hint { font-size: 12.5px; color: var(--muted); }
  .check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; }
  .check input { width: 18px; height: 18px; accent-color: var(--lime); }
  .row { display: flex; justify-content: flex-end; }
  .ok { font-size: 13px; color: var(--good-text); }
  .recent { list-style: none; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .recent li { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .recent a { color: var(--text); }
</style>
