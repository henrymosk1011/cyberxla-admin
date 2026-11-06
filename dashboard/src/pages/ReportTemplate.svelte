<script lang="ts">
  // The report template: the wording and order every new report starts from.
  // Saved in report_settings.template; the Sunday run fills in the
  // {placeholders}. Reports already made don't change.
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import DidItems from "../components/DidItems.svelte";
  import { blankFields, DEFAULT_TEMPLATE, fieldLabel, PLACEHOLDERS, resolveTemplate, templateDashes, unknownPlaceholders } from "../lib/template.ts";
  import type { ReportTemplate } from "../lib/types.ts";

  let draft = $state<ReportTemplate | null>(null);
  let saved = $state("");
  let period = $state<"weekly" | "monthly">("weekly");
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let confirm: Confirm;

  async function load() {
    try {
      const s = await db.reportSettings();
      draft = resolveTemplate(s.template);
      saved = JSON.stringify(draft);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load the template.";
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
    error = "";
    notice = "";
    const blanks = blankFields(draft);
    if (blanks.length) return (error = `Some fields are empty: ${blanks.map(fieldLabel).join(", ")}. Type something, or use Reset to defaults.`);
    // Drop What we did items left completely empty; one with words but no title can't be saved.
    draft.did_items = draft.did_items.filter((i) => i.title.trim() || i.text.trim());
    const untitled = draft.did_items.findIndex((i) => !i.title.trim());
    if (untitled >= 0) return (error = `What we did item ${untitled + 1} needs a title.`);
    busy = true;
    try {
      await db.saveReportSettings({ template: $state.snapshot(draft) as ReportTemplate });
      saved = JSON.stringify(draft);
      notice = "Template saved. Reports generated from now on use it; reports already made don't change.";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't save the template.";
    } finally {
      busy = false;
    }
  }
  async function resetAll() {
    if (!(await confirm.ask({ title: "Reset to the original wording?", body: "Every field goes back to the wording reports started with, including What we did. Nothing is saved until you press Save template.", action: "Reset" }))) return;
    draft = structuredClone(DEFAULT_TEMPLATE);
  }
  const discard = () => { draft = JSON.parse(saved); };

  // Leaving with unsaved changes: ask first.
  $effect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = async (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href^='#']");
      if (!a || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute("href")!;
      if (await confirm.ask({ title: "Leave without saving?", body: "Your changes to the template haven't been saved.", action: "Leave", danger: true })) {
        saved = JSON.stringify(draft);
        location.hash = href;
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); window.removeEventListener("click", onClick, true); };
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

<a class="back" href="#/reports/settings">← Report settings</a>
<header class="top">
  <p class="eyebrow">Patch reports</p>
  <h1>Report template</h1>
  <p class="lead">Every new report starts from this wording and order. Changes apply to reports generated after you save; reports already made don't change. Words in curly brackets, like <code>{"{computers}"}</code>, are filled in with each report's numbers and dates.</p>
</header>

{#if error}<p class="error banner" role="alert">{error}</p>{/if}
<p class="sr-only" role="status">{notice}</p>
{#if notice}<p class="notice" aria-hidden="true">{notice}</p>{/if}

{#if !draft || !p}
  <p class="muted">Loading…</p>
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

  <div class="savebar" class:clean={!dirty} role="region" aria-label="Save">
    <span>{dirty ? "Unsaved changes to the template." : "No unsaved changes"}</span>
    <div>
      {#if dirty}<button class="btn ghost" disabled={busy} onclick={discard}>Discard</button>{/if}
      <button class="btn primary" disabled={busy || !dirty} onclick={save}>{busy ? "Saving…" : "Save template"}</button>
    </div>
  </div>
{/if}

<Confirm bind:this={confirm} />

<style>
  .back { display: inline-block; font-size: 13px; color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .top { margin-bottom: 20px; max-width: 760px; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 10px; }
  .lead { color: var(--text-2); font-size: 14px; }
  code { font-family: var(--mono); font-size: 0.92em; color: var(--lime); }
  .banner, .notice { margin-bottom: 16px; }
  .notice { font-size: 14px; color: var(--good-text); }
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
  .periodbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; position: sticky; top: 8px; z-index: 5; padding: 8px 12px; border-radius: 999px; background: var(--plane); border: 1px solid var(--line); align-self: flex-start; }
  .periodbar span { font-size: 13px; font-weight: 600; color: var(--text-2); }
  fieldset.cols5 { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  fieldset legend { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .reset { flex-direction: row; justify-content: space-between; align-items: center; flex-wrap: wrap; }
  .phs { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .phs div { display: flex; flex-direction: column; gap: 1px; }
  .phs dd { color: var(--text-2); }
  .savebar { position: sticky; bottom: 12px; z-index: 10; margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--lime); border-radius: 14px; background: var(--surface-2); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); font-size: 14px; font-weight: 600; }
  .savebar div { display: flex; gap: 8px; }
  .savebar.clean { border-color: var(--line-2); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font-weight: 500; color: var(--text-2); }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }
  @media (max-width: 640px) {
    h1 { font-size: 26px; }
    .grid { grid-template-columns: 1fr; }
    fieldset.cols5 { grid-template-columns: 1fr 1fr; }
    .periodbar { border-radius: 14px; }
  }
</style>
