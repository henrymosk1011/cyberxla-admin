<script lang="ts">
  // Send now, Send later, Resend and Send me a test, with the email exactly
  // as it goes out (the same code the quote-action Edge Function runs).
  import Modal from "./Modal.svelte";
  import Field from "./Field.svelte";
  import EmailView from "./EmailView.svelte";
  import { defaultNote, defaultSubject, quoteEmail, type MailContext } from "../../../supabase/functions/_shared/emails.ts";
  import { messageOf } from "../lib/toast.svelte.ts";
  import type { Proposal, QuoteSettings } from "../lib/types.ts";

  let { open, mode, proposal, company, firstName, title, settings, emailReady = null, onclose, onsend, onschedule, ontest, onpublish }: {
    open: boolean;
    /** send: the first send or a revision. resend: email the latest version again. */
    mode: "send" | "resend";
    proposal: Proposal;
    company: string;
    firstName: string;
    /** The title with placeholders filled in. */
    title: string;
    settings: QuoteSettings | null;
    /** Whether email is set up (the RESEND_API_KEY secret); null while unknown. */
    emailReady?: boolean | null;
    onclose: () => void;
    onsend: (subject: string, note: string) => Promise<void>;
    onschedule: (at: string, subject: string, note: string) => Promise<void>;
    ontest: (subject: string, note: string) => Promise<string>;
    /** Freeze the version and make the link live without an email. */
    onpublish: () => Promise<void>;
  } = $props();

  const number = $derived(`Q${proposal.number}`);
  let subject = $state("");
  let note = $state("");
  let later = $state(false);
  let at = $state("");
  let view = $state<"email" | "text">("email");
  let busy = $state<"" | "send" | "test" | "publish">("");
  const noEmail = $derived(emailReady === false);
  let error = $state("");
  let done = $state("");

  // Fresh words each time it opens (or the subject and note saved with a schedule).
  $effect(() => {
    if (!open) return;
    subject = proposal.send_subject ?? defaultSubject(`Q${proposal.number}`, title);
    note = proposal.send_note ?? defaultNote(firstName, title);
    later = false;
    const d = new Date(Date.now() + 86400000);
    d.setHours(9, 0, 0, 0);
    at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`;
    error = ""; done = ""; busy = "";
  });

  const ctx = $derived<MailContext>({
    id: proposal.id, number, version: mode === "resend" ? proposal.version : proposal.version + 1, status: proposal.status, title, company, first_name: firstName,
    to: proposal.recipient_email, to_name: proposal.recipient_name || null, cc: proposal.cc, valid_until: proposal.valid_until, token: proposal.token,
    subject, note, settings: { notify_email: settings?.notify_email ?? "henry@cyberx.la", reply_to: settings?.reply_to ?? "henry@cyberx.la", from_name: settings?.from_name ?? "Henry at cyberxLA", stripe_mode: settings?.stripe_mode ?? "off" },
  });
  const mail = $derived(quoteEmail(ctx, mode === "resend" ? "resend" : "send"));
  const subjectError = $derived(!subject.trim() ? "Add a subject." : subject.length > 200 ? "Keep the subject under 200 characters." : "");
  const noteError = $derived(note.length > 2000 ? "Keep the note under 2,000 characters." : "");

  async function go() {
    if (subjectError || noteError) return;
    if (later && !at) { error = "Pick when to send it."; return; }
    busy = "send"; error = "";
    try {
      if (later) await onschedule(new Date(at).toISOString(), subject.trim(), note.trim());
      else await onsend(subject.trim(), note.trim());
    } catch (e) {
      error = messageOf(e, "That didn't go through. Try again.");
    } finally {
      busy = "";
    }
  }
  async function publish() {
    busy = "publish"; error = "";
    try {
      await onpublish();
    } catch (e) {
      error = messageOf(e, "That didn't go through. Try again.");
    } finally {
      busy = "";
    }
  }
  async function test() {
    if (subjectError || noteError) return;
    busy = "test"; error = ""; done = "";
    try {
      done = `Test sent to ${await ontest(subject.trim(), note.trim())}.`;
    } catch (e) {
      error = messageOf(e, "The test didn't send. Try again.");
    } finally {
      busy = "";
    }
  }
  // A quote only published (never emailed) is emailed for the first time, not again.
  const heading = $derived(mode === "resend" ? (proposal.link_only ? `Email ${number} to the client` : `Email ${number} again`) : proposal.revising ? `Send version ${proposal.version + 1} of ${number}` : `Send ${number}`);
</script>

<Modal {open} title={heading} onclose={onclose} wide persistent={busy !== ""}>
  <div class="send">
    <p class="to"><span class="muted">To</span> <strong>{proposal.recipient_email ?? "No recipient yet"}</strong>{#if proposal.cc.length}<span class="muted"> cc</span> {proposal.cc.join(", ")}{/if}
      <span class="muted">· from {settings?.from_name ?? "Henry at cyberxLA"}, replies go to {settings?.reply_to ?? "henry@cyberx.la"}</span></p>
    {#if noEmail}
      <p class="callout warn" role="status">Email isn't set up yet, so this can't be emailed. {mode === "send" ? "Publish it instead, then send the link yourself." : "Copy the link and send it yourself."} To turn email on, add the RESEND_API_KEY secret in Supabase (README, Setup for sending).</p>
    {/if}
    {#if mode === "send" && proposal.revising}
      <p class="callout">The client sees version {proposal.version} until this goes out. Same link, same number.</p>
    {/if}
    <Field id="sd-subject" label="Subject" required error={subjectError}>{#snippet children(a)}<input {...a} class="input" maxlength="200" bind:value={subject} />{/snippet}</Field>
    <Field id="sd-note" label="Note" hint="Shown above the View your quote button." error={noteError}>{#snippet children(a)}<textarea {...a} class="input" rows="5" maxlength="2000" bind:value={note}></textarea>{/snippet}</Field>

    {#if mode === "send" && !noEmail}
      <label class="check"><input type="checkbox" bind:checked={later} /> Send later</label>
      {#if later}
        <Field id="sd-at" label="Send on" hint="Your time zone. It goes out within a minute or two of this time.">{#snippet children(a)}<input {...a} class="input" type="datetime-local" bind:value={at} />{/snippet}</Field>
      {/if}
    {/if}

    <div class="pvhead">
      <h3>Email preview</h3>
      <div class="seg" role="group" aria-label="Email format">
        <button type="button" aria-pressed={view === "email"} onclick={() => (view = "email")}>Email</button>
        <button type="button" aria-pressed={view === "text"} onclick={() => (view = "text")}>Plain text</button>
      </div>
    </div>
    <p class="subj"><span class="muted">Subject:</span> {mail.subject}</p>
    {#if view === "email"}
      <EmailView html={mail.html} label="Email preview" />
    {:else}
      <pre class="text">{mail.text}</pre>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if done}<p class="ok" role="status">{done}</p>{/if}
    <div class="row">
      {#if !noEmail}<button type="button" class="btn" disabled={busy !== ""} onclick={test}>{busy === "test" ? "Sending test…" : `Send me a test`}</button>{/if}
      {#if mode === "send" && noEmail}
        <button type="button" class="btn primary" disabled={busy !== "" || !proposal.recipient_email} onclick={publish}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
      {/if}
      <span class="grow"></span>
      <button type="button" class="btn ghost" disabled={busy !== ""} onclick={onclose}>Cancel</button>
      {#if !noEmail}
        <button type="button" class="btn primary" disabled={busy !== "" || !proposal.recipient_email} onclick={go}>
          {busy === "send" ? (later ? "Scheduling…" : "Sending…") : later ? "Schedule" : mode === "resend" ? (proposal.link_only ? "Send email" : "Send again") : "Send now"}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .send { display: flex; flex-direction: column; gap: 14px; }
  .send :global(.input) { width: 100%; }
  .to { font-size: var(--fs-md); overflow-wrap: anywhere; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-2); }
  .pvhead { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 4px; }
  h3 { font-size: var(--fs-base); }
  .subj { font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: var(--fs-xs); background: var(--ink); border: 1px solid var(--line-2); border-radius: var(--radius-md); padding: 14px; max-height: 420px; overflow: auto; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grow { flex: 1; }
  .ok { color: var(--good-text); font-size: var(--fs-md); }
  .callout { margin: 0; }
</style>
