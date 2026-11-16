<script lang="ts">
  // The report template: the wording and order every new report starts from.
  // Saved in report_settings.template; the Sunday run fills in the
  // {placeholders}. Reports already made don't change.
  import { tick } from "svelte";
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import DidItems from "../components/DidItems.svelte";
  import LoadState from "../components/LoadState.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ReportsNav from "../components/ReportsNav.svelte";
  import SaveBar from "../components/SaveBar.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf } from "../lib/toast.svelte.ts";
  import { blankFields, DEFAULT_TEMPLATE, fieldLabel, PLACEHOLDERS, resolveTemplate, templateDashes, unknownPlaceholders } from "../lib/template.ts";
  import type { ReportTemplate } from "../lib/types.ts";

  let draft = $state<ReportTemplate | null>(null);
  let saved = $state("");
  let period = $state<"weekly" | "monthly">("weekly");
  let loadError = $state("");
  // How the last Save went, shown in the save bar (always on screen).
  let saveError = $state("");
  let saveDone = $state("");
  let busy = $state(false);
  let confirm: Confirm;

  async function load() {
    try {
      const s = await db.reportSettings();
      draft = resolveTemplate(s.template);
      saved = JSON.stringify(draft);
      loadError = "";
    } catch (e) {
      loadError = messageOf(e, "Check your connection and try again.");
    }
  }
  $effect(() => {
    load();
  });

  const dirty = $derived(!!draft && JSON.stringify(draft) !== saved);
  const unknown = $derived(draft ? unknownPlaceholders(draft) : []);
  const dashes = $derived(draft ? templateDashes(draft) : []);
  const isDefault = $derived(!!draft && JSON.stringify(draft) === JSON.stringify(DEFAULT_TEMPLATE));
  const p = $derived(draft ? draft[period] : null);
  const word = $derived(period === "weekly" ? "weekly" : "monthly");

  async function save() {
    if (!draft) return;
    saveError = "";
    saveDone = "";
    const blanks = blankFields(draft);
    if (blanks.length) {
      saveError = `Some fields are empty: ${blanks.map(fieldLabel).join(", ")}. Type something, or use Reset to defaults.`;
      // Show the weekly or monthly wording the first empty field is in, and put the cursor in it.
      const per = /^(weekly|monthly)\./.exec(blanks[0]!);
      if (per) period = per[1] as "weekly" | "monthly";
      await tick();
      [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".layout .main .field .input")].find((el) => !el.value.trim())?.focus();
      return;
    }
    // Drop What we did items left completely empty; one with words but no title can't be saved.
    draft.did_items = draft.did_items.filter((i) => i.title.trim() || i.text.trim());
    const untitled = draft.did_items.findIndex((i) => !i.title.trim());
    if (untitled >= 0) {
      saveError = `What we did item ${untitled + 1} needs a title.`;
      await tick();
      document.getElementById(`d-${untitled}-t`)?.focus();
      return;
    }
    busy = true;
    try {
      await db.saveReportSettings({ template: $state.snapshot(draft) as ReportTemplate });
      saved = JSON.stringify(draft);
      saveDone = "Template saved. Reports generated from now on use it; reports already made don't change.";
    } catch (e) {
      saveError = messageOf(e, "Couldn't save the template. Try again.");
    } finally {
      busy = false;
    }
  }
  async function resetAll() {
    if (!(await confirm.ask({ title: "Reset to the original wording?", body: "Every field goes back to the wording reports started with, including What we did. Nothing is saved until you press Save template.", action: "Reset" }))) return;
    draft = structuredClone(DEFAULT_TEMPLATE);
  }
  const discard = () => { saveError = ""; draft = JSON.parse(saved); };

  // Leaving with unsaved changes: ask first.
  guardUnsaved(() => dirty, () => confirm.ask({ title: "Leave without saving?", body: "Your changes to the template haven't been saved.", action: "Leave", danger: true }));
  // A new edit clears what the last Save said.
  $effect(() => {
    if (dirty) saveDone = "";
  });

  const ph = (...names: string[]) => `Placeholders: ${names.map((n) => `{${n}}`).join(", ")}`;
</script>

<!-- obj is a template object or one of its string lists; key is a field name or list index. -->
{#snippet field(id: string, label: string, obj: any, key: string | number, hint = "", rows = 1)}
  <div class="field">
    <label for={id}>{label}</label>
    {#if rows > 1}
      <textarea {id} class="input" {rows} bind:value={obj[key]} aria-describedby={hint ? `${id}-h` : undefined}></textarea>
    {:else}
      <input {id} class="input" bind:value={obj[key]} aria-describedby={hint ? `${id}-h` : undefined} />
    {/if}
    {#if hint}<span id="{id}-h" class="hint">{hint}</span>{/if}
  </div>
{/snippet}

<PageHeader title="Report template">
  {#snippet meta()}
    <p class="lead">Every new report starts from this wording and order. Changes apply to reports generated after you save; reports already made don't change. Words in curly brackets, like <code>{"{computers}"}</code>, are filled in with each report's numbers and dates.</p>
  {/snippet}
</PageHeader>
<ReportsNav current="template" />

{#if !draft || !p}
  <LoadState error={loadError} what="the template" onretry={() => { loadError = ""; load(); }} />
{:else}
  {#if unknown.length}
    <div class="callout warn" role="note"><strong>Check these placeholders</strong><p>{unknown.map((u) => `${u.name} (${fieldLabel(u.path)})`).join(", ")} {unknown.length === 1 ? "isn't" : "aren't"} on the placeholder list, so {unknown.length === 1 ? "it" : "they"} would show as typed.</p></div>
  {/if}
  {#if dashes.length}
    <div class="callout warn" role="note"><strong>Dashes found</strong><p>House rule: no dashes as punctuation. Check {dashes.map(fieldLabel).join(", ")}.</p></div>
  {/if}

  <div class="layout">
    <div class="main">
      <section class="card">
        <div class="card-head"><h2>What we did</h2><button type="button" class="btn sm" onclick={() => draft!.did_items.push({ title: "", text: "" })}>Add item</button></div>
        <p class="hint">The same list goes in weekly and monthly reports.</p>
        <DidItems bind:items={draft.did_items} />
      </section>

      <div class="periodbar">
        <span id="pp-l">Wording for</span>
        <div class="seg" role="group" aria-labelledby="pp-l">
          <button type="button" aria-pressed={period === "weekly"} onclick={() => (period = "weekly")}>Weekly reports</button>
          <button type="button" aria-pressed={period === "monthly"} onclick={() => (period = "monthly")}>Monthly reports</button>
        </div>
      </div>

      <section class="card">
        <div class="card-head"><h2>Top of the {word} report</h2></div>
        <div class="grid">
          {@render field("t-label", "Label (top right, in capitals)", p, "label")}
          {@render field("t-did", "What we did title", p, "did_title")}
          <div class="wide">{@render field("t-sub", "Subtitle", p, "subtitle", period === "weekly" ? ph("window_date", "report_date") : ph("month", "runs", "report_date"))}</div>
          <div class="wide">{@render field("t-head", "Headline", p, "headline", period === "weekly" ? ph("patched", "computers", "installs", "attention") : ph("rate", "runs", "computers", "installs"), 2)}</div>
          {@render field("t-pill-ok", "Status pill when nothing needs attention", draft, "pill_clear", "Same for weekly and monthly.")}
          {@render field("t-pill-att", "Status pill when something does", draft, "pill_attention", ph("attention"))}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Numbers ({word})</h2></div>
        <div class="grid">
          {#each p.kpi_labels as _, i (i)}{@render field(`t-kpi-${i}`, `Label under number ${i + 1}`, p.kpi_labels, i)}{/each}
        </div>
        {#if period === "monthly"}{@render field("t-weeks", "Chart title", p, "weeks_title")}{/if}
      </section>

      <section class="card">
        <div class="card-head"><h2>Computers and updates</h2></div>
        <div class="grid">
          {@render field("t-pc", "Computers table title", draft, "computers_title", "Same for weekly and monthly.")}
          {@render field("t-upd", `Updates section title (${word})`, p, "updates_title")}
        </div>
        <fieldset class="cols5">
          <legend>Column headings ({word})</legend>
          {#each p.columns as _, i (i)}{@render field(`t-col-${i}`, `Column ${i + 1}`, p.columns, i)}{/each}
        </fieldset>
        <div class="grid">
          {@render field("t-empty-ok", "When a computer had nothing to install", draft, "updates_empty_ok")}
          {@render field("t-empty-fail", "When its patch run didn't finish (weekly)", draft, "updates_empty_failed")}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Open security risks</h2></div>
        {@render field("t-sec-title", "Section title", draft, "security_title")}
        {@render field("t-sec-text", "Text", draft, "security_text", `${ph("critical", "high")}. **Two asterisks** make text bold.`, 4)}
        {@render field("t-sec-intro", "Before the app list", draft, "apps_intro")}
        {@render field("t-sec-note", "Closing note", draft, "security_note", "", 2)}
      </section>

      <section class="card">
        <div class="card-head"><h2>Next patch window</h2></div>
        <div class="grid">
          {@render field("t-next-label", "Label", draft, "next_label")}
          {@render field("t-next-when", "When", draft, "next_when", ph("next_day"))}
          <div class="wide">{@render field("t-next-note", "Note", draft, "next_note", "", 2)}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Network updates</h2></div>
        <p class="hint">Only on a report for a period when at least one of the client's UniFi devices was updated. The section then lists every device, the router first: the updated ones with the update lines; the others with the up to date lines, or the update waiting lines when UniFi shows an update out for them (so a report never says none is needed). Same for weekly and monthly, and editable on each report.</p>
        {@render field("t-net-title", "Section title", draft, "network_title")}
        <div class="grid">
          {@render field("t-router-title", "Router updated: title", draft, "router_update_title")}
          <div class="wide">{@render field("t-router-text", "Router updated: text", draft, "router_update_text", ph("version", "from", "date"), 2)}</div>
          {@render field("t-dev-title", "Other device updated (access points, switches): title", draft, "device_update_title", ph("device"))}
          <div class="wide">{@render field("t-dev-text", "Other device updated: text", draft, "device_update_text", ph("device", "version", "from", "date"), 2)}</div>
          {@render field("t-chk-title", "Not updated and up to date (router included): title", draft, "device_checked_title", ph("device", "period"))}
          <div class="wide">{@render field("t-chk-text", "Not updated and up to date: text", draft, "device_checked_text", ph("device", "version", "period"), 2)}</div>
          {@render field("t-wait-title", "Not updated, update waiting in UniFi: title", draft, "device_waiting_title", ph("device", "period"))}
          <div class="wide">{@render field("t-wait-text", "Not updated, update waiting: text", draft, "device_waiting_text", ph("device", "version", "period"), 2)}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Email ({word})</h2></div>
        {@render field("t-subj", "Subject", p, "subject", period === "weekly" ? ph("client", "window_short") : ph("client", "month"))}
        {@render field("t-body", "Body", p, "body", `A blank line starts a new paragraph. **Two asterisks** make text bold. ${ph("client", "summary", period === "weekly" ? "window_date" : "month", "next_day")}`, 12)}
      </section>

      <section class="card reset">
        <p class="hint">{isDefault ? "This is the original wording." : "Go back to the wording reports started with."}</p>
        <button type="button" class="btn sm" disabled={isDefault} onclick={resetAll}>Reset to defaults</button>
      </section>
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Placeholders</h2></div>
        <p class="hint">Type these, curly brackets included. Each report fills in its own.</p>
        <dl class="phs">
          {#each Object.entries(PLACEHOLDERS) as [k, v] (k)}<div><dt><code>{`{${k}}`}</code></dt><dd>{v}</dd></div>{/each}
        </dl>
      </section>
    </aside>
  </div>

  <SaveBar {dirty} {busy} error={saveError} done={saveDone} onsave={save} ondiscard={discard} label="Save template" hint="Unsaved changes to the template." />
{/if}

<Confirm bind:this={confirm} />

<style>
  .lead { color: var(--text-2); font-size: 14px; max-width: 760px; margin-top: 10px; }
  code { font-family: var(--mono); font-size: 0.92em; color: var(--lime); }
  .callout { border: 1px solid var(--line-2); border-left: 3px solid var(--warning); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; font-size: 14px; background: var(--surface); }
  .callout p { margin-top: 2px; color: var(--text-2); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .side { position: sticky; top: 16px; min-width: 0; }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head { margin-bottom: 0; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .wide { grid-column: 1 / -1; }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field label { font-size: 13px; font-weight: 500; color: var(--text-2); }
  .input { width: 100%; min-width: 0; }
  textarea.input { line-height: 1.5; }
  .hint { font-size: 12.5px; color: var(--muted); }
  .periodbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; position: sticky; top: calc(var(--topbar-h) + 8px); z-index: 5; padding: 8px 12px; border-radius: 999px; background: var(--plane); border: 1px solid var(--line); align-self: flex-start; }
  .periodbar span { font-size: 13px; font-weight: 600; color: var(--text-2); }
  fieldset.cols5 { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  fieldset legend { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .reset { flex-direction: row; justify-content: space-between; align-items: center; flex-wrap: wrap; }
  .phs { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .phs div { display: flex; flex-direction: column; gap: 1px; }
  .phs dd { color: var(--text-2); }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    fieldset.cols5 { grid-template-columns: 1fr 1fr; }
    .periodbar { border-radius: 14px; }
  }
</style>
