<script lang="ts">
  import db from "$db";
  import Icon from "../components/Icon.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import Field from "../components/Field.svelte";
  import SaveBar from "../components/SaveBar.svelte";
  import LoadState from "../components/LoadState.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import type { AuditSettings } from "../lib/types.ts";

  let saved = $state<AuditSettings | null | undefined>(undefined);
  let form = $state<AuditSettings | null>(null);
  let loadError = $state("");
  let busy = $state(false);
  let error = $state("");

  async function load() {
    try {
      const s = await db.auditSettings();
      saved = s; form = structuredClone(s); loadError = "";
    } catch (e) { loadError = messageOf(e, "Couldn't load the settings."); }
  }
  $effect(() => { load(); });

  const dirty = $derived(!!form && !!saved && JSON.stringify(form) !== JSON.stringify({ ...saved, updated_at: form.updated_at }));
  guardUnsaved(() => dirty, () => Promise.resolve(confirm("Leave without saving your changes?")));

  async function save() {
    if (!form) return;
    busy = true; error = "";
    try {
      const { mode, passive_enabled, active_enabled, sender_email, sender_name, reply_to, default_subject, default_body } = form;
      await db.saveAuditSettings({ mode, passive_enabled, active_enabled, sender_email: sender_email.trim(), sender_name: sender_name.trim(), reply_to: reply_to.trim(), default_subject, default_body });
      toast.success("Settings saved.");
      await load();
    } catch (e) { error = messageOf(e, "Couldn't save the settings."); }
    finally { busy = false; }
  }
</script>

<a class="back" href="#/prospects"><Icon name="arrow-left" size={14} /> Prospects</a>

{#if saved === undefined}
  <LoadState error={loadError} what="the settings" onretry={load} />
{:else if form}
  <PageHeader title="Audit settings" sub="How security audits are sent" />

  <section class="card">
    <h2>Sending mode</h2>
    <p class="muted intro">This is the safety switch. In preview, every audit email goes to henry@cyberx.la only, so you can review before anyone outside sees it.</p>
    <div class="modes">
      <label class="mode" class:on={form.mode === "preview"}>
        <input type="radio" name="mode" value="preview" bind:group={form.mode} />
        <span class="mode-h">Preview</span>
        <span class="mode-d">Audit emails go to henry@cyberx.la only. Prospects are never emailed.</span>
      </label>
      <label class="mode" class:on={form.mode === "live"}>
        <input type="radio" name="mode" value="live" bind:group={form.mode} />
        <span class="mode-h">Live</span>
        <span class="mode-d">Send emails the report to the prospect, with replies going to you.</span>
      </label>
    </div>
    {#if form.mode === "live"}<p class="warn">Live mode is on. Sending an audit emails a real business. Test audits still go to you only.</p>{/if}
  </section>

  <section class="card">
    <h2>What the scanner may run</h2>
    <label class="toggle">
      <input type="checkbox" bind:checked={form.passive_enabled} />
      <span><strong>Passive audits</strong><span class="muted">{" · external posture from public data only. Safe on any prospect."}</span></span>
    </label>
    <label class="toggle">
      <input type="checkbox" bind:checked={form.active_enabled} />
      <span><strong>Active audits</strong><span class="muted">{" · intrusive testing. Even with this on, each target still needs a recorded signed authorization."}</span></span>
    </label>
  </section>

  <section class="card">
    <h2>Sender</h2>
    <div class="two">
      <Field id="s-name" label="From name"><input id="s-name" class="input" bind:value={form.sender_name} maxlength="80" /></Field>
      <Field id="s-from" label="From address"><input id="s-from" class="input" type="email" bind:value={form.sender_email} maxlength="254" /></Field>
    </div>
    <Field id="s-reply" label="Reply to"><input id="s-reply" class="input" type="email" bind:value={form.reply_to} maxlength="254" /></Field>
  </section>

  <section class="card">
    <h2>Default email</h2>
    <p class="muted intro">The starting subject and message for a new audit. Use <code>{"{business}"}</code> for the business name and <code>{"{grade}"}</code> for the grade. You can edit any audit's email before it sends.</p>
    <Field id="s-subj" label="Subject"><input id="s-subj" class="input" bind:value={form.default_subject} maxlength="300" /></Field>
    <Field id="s-body" label="Message"><textarea id="s-body" class="input body" bind:value={form.default_body} maxlength="20000" rows="8"></textarea></Field>
  </section>

  <SaveBar {dirty} {busy} {error} onsave={save} ondiscard={() => (form = structuredClone(saved!))} />
{/if}

<style>
  .intro { font-size: var(--fs-sm); margin: -2px 0 14px; }
  h2 { font-size: var(--fs-lg); margin-bottom: 4px; }
  section.card + section.card { margin-top: 20px; }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .mode { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-md); cursor: pointer; transition: border-color 0.2s, background 0.2s; }
  .mode.on { border-color: var(--lime); background: var(--lime-tint); }
  .mode input { position: absolute; opacity: 0; }
  .mode-h { font-weight: 700; }
  .mode-d { font-size: var(--fs-sm); color: var(--muted); }
  .warn { margin-top: 14px; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--warning) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent); color: var(--text); font-size: var(--fs-sm); }
  .toggle { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; }
  .toggle input { margin-top: 3px; flex: none; width: 18px; height: 18px; }
  .toggle + .toggle { border-top: 1px solid var(--line); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .body { resize: vertical; min-height: 140px; font-family: inherit; }
  code { font-family: var(--mono, monospace); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  @media (max-width: 640px) { .modes, .two { grid-template-columns: 1fr; } }
</style>
