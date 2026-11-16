<script lang="ts">
  // Reports for one client: whether they are on, their Action1 group, who gets
  // them, computers to always leave off, their UniFi console, and recent
  // reports. The card shows the settings; Edit opens the form.
  import { tick, untrack } from "svelte";
  import db from "$db";
  import Field from "./Field.svelte";
  import Modal from "./Modal.svelte";
  import ReportPill from "./ReportPill.svelte";
  import { parseEmails, parseNames, periodLabel, reportState } from "../lib/reports.ts";
  import { toast } from "../lib/toast.svelte.ts";
  import type { Client, ReportRow } from "../lib/types.ts";

  let { client, onsaved, dirty = $bindable(false) }: { client: Client; onsaved: () => void; /** True while the form has unsaved changes. */ dirty?: boolean } = $props();

  // Until migration 0010 runs these columns don't exist; show the card empty instead of breaking the page.
  const to0 = $derived((client.report_recipients ?? []).join(", "));
  const cc0 = $derived((client.report_cc ?? []).join(", "));
  const off0 = $derived((client.report_exclude ?? []).join("\n"));
  const offCount = $derived((client.report_exclude ?? []).length);

  let form = $state({ group: "", to: "", cc: "", enabled: false, off: "", unifi: "" });
  let reports = $state<ReportRow[]>([]);
  // What is wrong with each field, shown under it.
  let errors = $state<{ group?: string; to?: string; cc?: string; off?: string; unifi?: string }>({});
  let formError = $state("");
  let busy = $state(false);
  let editing = $state(false);

  function fill() {
    form = { group: client.action1_group ?? "", to: to0, cc: cc0, enabled: !!client.reports_enabled, off: off0, unifi: client.unifi_console ?? "" };
    errors = {};
    formError = "";
  }
  // Fill the form only when these saved values change, not every time the
  // client page reloads (saving notes elsewhere shouldn't wipe edits here).
  const savedKey = $derived(JSON.stringify([client.id, client.action1_group, to0, cc0, client.reports_enabled, off0, client.unifi_console]));
  $effect(() => {
    void savedKey;
    untrack(fill);
  });
  $effect(() => {
    const id = client.id;
    db.reports().then((r) => (reports = r.filter((x) => x.client_id === id && !x.is_test).slice(0, 5)), () => {});
  });

  const changed = $derived(form.group !== (client.action1_group ?? "") || form.to !== to0 || form.cc !== cc0
    || form.enabled !== !!client.reports_enabled || parseNames(form.off).join("\n") !== off0 || form.unifi.trim() !== (client.unifi_console ?? ""));
  $effect(() => {
    dirty = changed;
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    errors = {};
    formError = "";
    const to = parseEmails(form.to), cc = parseEmails(form.cc);
    const group = form.group.trim(), unifi = form.unifi.trim(), off = parseNames(form.off);
    if (form.enabled && !group) errors.group = "To turn reports on, add the Action1 group.";
    if (to.invalid.length) errors.to = `These don't look like email addresses: ${to.invalid.join(", ")}`;
    else if (to.emails.length > 10) errors.to = "Up to 10 recipients.";
    else if (form.enabled && !to.emails.length) errors.to = "To turn reports on, add at least one recipient.";
    if (cc.invalid.length) errors.cc = `These don't look like email addresses: ${cc.invalid.join(", ")}`;
    else if (cc.emails.length > 10) errors.cc = "Up to 10 cc.";
    if (off.length > 200 || off.some((n) => n.length > 120)) errors.off = "Up to 200 computers, each name up to 120 characters.";
    if (unifi.length > 200) errors.unifi = "The UniFi console name can be up to 200 characters.";
    const first = (["group", "to", "cc", "off", "unifi"] as const).find((k) => errors[k]);
    if (first) {
      await tick();
      document.getElementById(`r-${first}`)?.focus();
      return;
    }
    busy = true;
    try {
      await db.updateClient(client.id, { action1_group: group || null, report_recipients: to.emails, report_cc: cc.emails, reports_enabled: form.enabled, report_exclude: off, unifi_console: unifi || null });
      toast.success("Report settings saved.");
      editing = false;
      onsaved();
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      if (/taken/.test(m)) {
        errors.group = "Another client already uses that Action1 group.";
        await tick();
        document.getElementById("r-group")?.focus();
      } else formError = m || "Couldn't save. Try again.";
    } finally {
      busy = false;
    }
  }
  function cancel() {
    editing = false;
    fill();
  }
</script>

<section class="card">
  <div class="card-head"><h2>Reports</h2><button class="btn sm" onclick={() => (editing = true)}>Edit<span class="sr-only"> report settings</span></button></div>
  <dl class="facts">
    <div><dt>Sending</dt><dd><ReportPill label={client.reports_enabled ? "On, weekly and monthly" : "Off"} tone={client.reports_enabled ? "good" : "muted"} /></dd></div>
    <div><dt>Action1 group</dt><dd class:unset={!client.action1_group}>{client.action1_group || "Not set"}</dd></div>
    <div><dt>Send to</dt><dd class:unset={!to0}>{to0 || "Not set"}</dd></div>
    {#if cc0}<div><dt>Cc</dt><dd>{cc0}</dd></div>{/if}
    <div><dt>Always left off</dt><dd class:unset={!offCount}>{offCount ? `${offCount} ${offCount === 1 ? "computer" : "computers"}` : "None"}</dd></div>
    <div><dt>UniFi console</dt><dd class:unset={!client.unifi_console}>{client.unifi_console || "Not set"}</dd></div>
  </dl>
  {#if changed && !editing}<p class="draft">You have unsaved changes here. <button class="link" onclick={() => (editing = true)}>Keep editing</button></p>{/if}
  {#if reports.length}
    <ul class="recent">
      {#each reports as r (r.id)}
        {@const st = reportState(r)}
        <li><a href="#/reports/{r.id}">{periodLabel(r)}</a> <ReportPill label={st.label} tone={st.tone} /></li>
      {/each}
    </ul>
  {/if}
</section>

<Modal open={editing} title="Report settings" onclose={() => (editing = false)} persistent={changed}>
  <form class="form" onsubmit={save} novalidate>
    <label class="check"><input type="checkbox" bind:checked={form.enabled} /> Send weekly and monthly reports</label>
    <Field id="r-group" label="Action1 group" hint="Exactly as named in Action1." error={errors.group}>{#snippet children(a)}<input {...a} class="input" maxlength="80" autocomplete="off" bind:value={form.group} />{/snippet}</Field>
    <Field id="r-to" label="Send to" hint="Separate addresses with commas." error={errors.to}>{#snippet children(a)}<input {...a} class="input" autocomplete="off" bind:value={form.to} />{/snippet}</Field>
    <Field id="r-cc" label="Cc" error={errors.cc}>{#snippet children(a)}<input {...a} class="input" autocomplete="off" bind:value={form.cc} />{/snippet}</Field>
    <Field id="r-off" label="Always leave off these computers" error={errors.off}
      hint="Names as they show on the report, for example Front Desk. They're left out of every future report for this client, numbers included.">
      {#snippet children(a)}<textarea {...a} class="input" rows="3" autocomplete="off" placeholder="One name per line" bind:value={form.off}></textarea>{/snippet}
    </Field>
    <Field id="r-unifi" label="UniFi console" error={errors.unifi}
      hint="Optional. The router's name as UniFi shows it (the [TAG] can be left off). Its software version goes on your internal report, and a router update goes on the client's report.">
      {#snippet children(a)}<input {...a} class="input" maxlength="200" autocomplete="off" bind:value={form.unifi} />{/snippet}
    </Field>
    <p class="hint">Changes apply to reports made after you save. Reports already made keep their recipients (edit those on the report).</p>
    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    <div class="row">
      <button type="button" class="btn ghost" onclick={cancel}>Cancel</button>
      <button class="btn primary" disabled={!changed || busy}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </form>
</Modal>

<style>
  .facts { display: flex; flex-direction: column; gap: 10px; }
  .facts div { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; align-items: baseline; font-size: 14px; }
  dt { color: var(--muted); font-size: 13px; }
  dd { overflow-wrap: anywhere; }
  .unset { color: var(--text-2); }
  .draft { margin-top: 12px; font-size: 13px; color: var(--warning); }
  .link { border: 0; background: none; padding: 0; color: var(--lime); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
  .form { display: flex; flex-direction: column; gap: 12px; }
  .form :global(.input) { width: 100%; min-width: 0; }
  .form :global(textarea.input) { min-height: 76px; }
  .hint { font-size: 12.5px; color: var(--muted); }
  .check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; }
  .check input { width: 18px; height: 18px; accent-color: var(--lime); }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .recent { list-style: none; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .recent li { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .recent a { color: var(--text); }
</style>
