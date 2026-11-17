<script lang="ts">
  import db from "$db";
  import Field from "../components/Field.svelte";
  import LoadState from "../components/LoadState.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import QuotesNav from "../components/QuotesNav.svelte";
  import SaveBar from "../components/SaveBar.svelte";
  import { ago } from "../lib/format.ts";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import Confirm from "../components/Confirm.svelte";
  import { messageOf } from "../lib/toast.svelte.ts";
  import type { QuoteSettings } from "../lib/types.ts";

  let s = $state<QuoteSettings | undefined>(undefined);
  let form = $state({ notify_email: "", reply_to: "", from_name: "", default_valid_days: 30, remind_unviewed_days: 3, remind_expiry_days: 2 });
  let error = $state("");
  let busy = $state(false);
  let saveError = $state("");
  let done = $state("");
  let confirm: Confirm;

  const pickForm = (x: QuoteSettings) => ({ notify_email: x.notify_email, reply_to: x.reply_to, from_name: x.from_name, default_valid_days: x.default_valid_days, remind_unviewed_days: x.remind_unviewed_days, remind_expiry_days: x.remind_expiry_days });
  async function load() {
    try { s = await db.quoteSettings(); form = pickForm(s); error = ""; } catch (e) { error = messageOf(e, "Check your connection."); }
  }
  load();
  const dirty = $derived(!!s && JSON.stringify(form) !== JSON.stringify(pickForm(s)));
  guardUnsaved(() => dirty, () => confirm.ask({ title: "Leave without saving?", body: "Your settings haven't been saved.", action: "Leave", danger: true }));

  const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
  async function save() {
    saveError = ""; done = "";
    if (!EMAIL.test(form.notify_email.trim()) || !EMAIL.test(form.reply_to.trim())) { saveError = "Check the two email addresses."; return; }
    if (!form.from_name.trim() || /[<>"]/.test(form.from_name)) { saveError = "The sender name can't be empty or use < > or quotes."; return; }
    busy = true;
    try {
      await db.saveQuoteSettings({ ...form, notify_email: form.notify_email.trim().toLowerCase(), reply_to: form.reply_to.trim().toLowerCase(), from_name: form.from_name.trim() });
      await load(); done = "Saved.";
    } catch (e) { saveError = messageOf(e, "Couldn't save."); } finally { busy = false; }
  }
</script>

<PageHeader title="Quotes" sub="Who quote emails come from and go to, and when follow ups go out." />
<QuotesNav current="settings" />

{#if s === undefined}
  <LoadState {error} what="quote settings" onretry={load} />
{:else}
  <div class="cols">
    <div class="main">
      <section class="card">
        <div class="card-head"><h2>Email</h2></div>
        <div class="grid">
          <Field id="qs-from" label="Sender name" hint="Emails come from this name at quotes@notify.cyberx.la.">{#snippet children(a)}<input {...a} class="input" maxlength="60" bind:value={form.from_name} />{/snippet}</Field>
          <Field id="qs-reply" label="Replies go to" hint="Also shown on quote pages.">{#snippet children(a)}<input {...a} class="input" type="email" bind:value={form.reply_to} />{/snippet}</Field>
          <Field id="qs-notify" label="Notify me at" hint="First opens, change requests, acceptances, payments, and Send me a test." wide>{#snippet children(a)}<input {...a} class="input" type="email" bind:value={form.notify_email} />{/snippet}</Field>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Dates and follow ups</h2></div>
        <div class="grid">
          <Field id="qs-valid" label="New quotes are valid for (days)">{#snippet children(a)}<input {...a} class="input" type="number" min="1" max="365" bind:value={form.default_valid_days} />{/snippet}</Field>
          <span></span>
          <Field id="qs-unviewed" label="Remind if not opened after (days)">{#snippet children(a)}<input {...a} class="input" type="number" min="1" max="30" bind:value={form.remind_unviewed_days} />{/snippet}</Field>
          <Field id="qs-expiry" label="Remind before it expires (days)">{#snippet children(a)}<input {...a} class="input" type="number" min="1" max="30" bind:value={form.remind_expiry_days} />{/snippet}</Field>
        </div>
        <p class="muted small">Follow ups go only to quotes with Remind the client turned on, between 9 AM and 5 PM Pacific.</p>
      </section>
    </div>
    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Scheduler</h2></div>
        <p class="small">{s.cron_seen_at ? `Send later, follow ups and alerts last ran ${ago(s.cron_seen_at)}.` : "The scheduler hasn't run yet."}</p>
        <p class="muted small">The database checks every minute for quotes to send, reminders and alerts.</p>
      </section>
    </aside>
  </div>
  <SaveBar {dirty} {busy} error={saveError} {done} onsave={save} ondiscard={() => s && (form = pickForm(s))} />
{/if}
<Confirm bind:this={confirm} />

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid :global(.input) { width: 100%; }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head { margin-bottom: 0; }
  .small { font-size: var(--fs-sm); }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
