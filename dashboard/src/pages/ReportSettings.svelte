<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import LoadState from "../components/LoadState.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ReportsNav from "../components/ReportsNav.svelte";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { thisWeek } from "../lib/reports.ts";
  import type { Client, ReportRow, ReportSettings } from "../lib/types.ts";

  let { clients }: { clients: Client[] } = $props();

  let saved = $state<ReportSettings | null>(null);
  let form = $state({ mode: "preview" as ReportSettings["mode"], auto_send_default: true, generate_time: "12:00", send_time: "08:00", sunday_review_email: true });
  let rows = $state<ReportRow[]>([]);
  let loadError = $state("");
  let error = $state("");
  let busy = $state(false);
  let confirm: Confirm;

  const hm = (t: string) => t.slice(0, 5);
  async function load() {
    try {
      const [s, r] = await Promise.all([db.reportSettings(), db.reports()]);
      saved = s;
      rows = r;
      form = { mode: s.mode, auto_send_default: s.auto_send_default, generate_time: hm(s.generate_time), send_time: hm(s.send_time), sunday_review_email: s.sunday_review_email };
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (!saved) loadError = m;
      else toast.error(`Couldn't refresh the settings. ${m}`);
    }
  }
  $effect(() => {
    load();
  });

  const dirty = $derived(!!saved && (form.mode !== saved.mode || form.auto_send_default !== saved.auto_send_default || form.generate_time !== hm(saved.generate_time)
    || form.send_time !== hm(saved.send_time) || form.sunday_review_email !== saved.sunday_review_email));
  const timeOk = (t: string) => /^\d{2}:\d{2}$/.test(t) && t <= "15:00";
  const on = $derived([...clients].filter((c) => c.reports_enabled).sort((a, b) => (a.company ?? "").localeCompare(b.company ?? "")));
  const off = $derived(clients.filter((c) => !c.reports_enabled && c.status !== "former").length);
  const name = (c: Client) => c.company || c.contact_name || "Unnamed client";

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!saved) return;
    error = "";
    if (!timeOk(form.generate_time) || !timeOk(form.send_time)) return (error = "Times must be 3:00 PM or earlier.");
    if (form.mode === "live" && saved.mode !== "live") {
      const n = thisWeek(rows).toHold.length;
      const ok = await confirm.ask({
        title: "Switch to live?",
        body: `From now on, reports go to clients at their send time${n ? `, starting with the ${n} scheduled this week` : ""}. Test reports still go to you only.`,
        action: "Switch to live",
        danger: true,
      });
      if (!ok) return;
    }
    busy = true;
    try {
      await db.saveReportSettings({ ...form });
      toast.success(form.mode === "live" ? "Settings saved. Mode is live." : "Settings saved.");
      await load();
    } catch (err) {
      error = messageOf(err, "Couldn't save the settings. Try again.");
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Report settings" />
<ReportsNav current="settings" />

{#if !saved}
  <LoadState error={loadError} what="the settings" onretry={() => { loadError = ""; load(); }} />
{:else}
  <div class="cols">
    <form class="card form" onsubmit={save}>
      <fieldset>
        <legend>Who gets reports</legend>
        <div class="seg" role="group" aria-label="Mode">
          <button type="button" aria-pressed={form.mode === "preview"} onclick={() => (form.mode = "preview")}>Preview</button>
          <button type="button" aria-pressed={form.mode === "live"} onclick={() => (form.mode = "live")}>Live</button>
        </div>
        <p class="hint">{form.mode === "live" ? "Live: reports go to each client's recipients, with replies to you." : "Preview: every report comes to you instead, tagged with who it's for. Nothing reaches a client."}</p>
        <!-- The switch looks instant, so say plainly what is in effect until Save. -->
        {#if form.mode !== saved.mode}
          <p class="pending" role="status"><strong>Not saved yet.</strong> The mode is still {saved.mode === "live" ? "Live" : "Preview"}: reports keep {saved.mode === "live" ? "going to clients" : "coming to you only"} until you press Save settings.</p>
        {:else}
          <p class="now">In effect now: <strong>{saved.mode === "live" ? "Live" : "Preview"}</strong></p>
        {/if}
      </fieldset>

      <fieldset>
        <legend>New reports</legend>
        <label class="check"><input type="checkbox" bind:checked={form.auto_send_default} /> Schedule them to send automatically</label>
        <p class="hint">{form.auto_send_default ? "Each new report sends at the send time unless you hold it." : "Each new report starts on hold until you resume it."} Reports that look off (no patch run that week, a dash in the text) always start on hold.</p>
        <label class="check"><input type="checkbox" bind:checked={form.sunday_review_email} /> Email me when Sunday's drafts are ready</label>
        <p class="hint">You get an email about failures either way.</p>
      </fieldset>

      <fieldset>
        <legend>Times (Pacific)</legend>
        <div class="two">
          <div class="field"><label for="gen">Drafts made Sunday at</label><input id="gen" class="input" type="time" min="00:00" max="15:00" step="900" required bind:value={form.generate_time} /></div>
          <div class="field"><label for="snd">Sent Monday at</label><input id="snd" class="input" type="time" min="00:00" max="15:00" step="900" required bind:value={form.send_time} /></div>
        </div>
        <p class="hint">Up to 3:00 PM: the GitHub schedules run hourly through Sunday and Monday until then, so expect each within the hour after.</p>
      </fieldset>

      <!-- Right above the button, so it is on screen when Save is pressed. -->
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="row"><button class="btn primary" disabled={!dirty || busy}>{busy ? "Saving…" : "Save settings"}</button></div>
    </form>

    <div class="stack">
    <section class="card">
      <div class="card-head"><h2>Clients getting reports</h2><span class="sub">Set on each client's page</span></div>
      {#if on.length}
        <ul class="clients">
          {#each on as c (c.id)}
            <li>
              <a href="#/clients/{c.id}"><strong>{name(c)}</strong></a>
              <span class="muted">Action1 group {c.action1_group} · to {(c.report_recipients ?? []).join(", ")}{c.report_cc?.length ? ` · cc ${c.report_cc.join(", ")}` : ""}{c.status !== "active" ? ` · ${c.status}` : ""}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">No clients yet. Open a client and fill in its Reports card.</p>
      {/if}
      {#if off}<p class="hint">{off} other {off === 1 ? "client doesn't" : "clients don't"} get reports.</p>{/if}
    </section>
    </div>
  </div>
{/if}

<Confirm bind:this={confirm} />

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .form { display: flex; flex-direction: column; gap: 20px; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  legend { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  .hint { font-size: 13px; color: var(--muted); }
  .now { font-size: 13px; color: var(--text-2); }
  .pending { font-size: 13px; color: var(--text); padding: 8px 12px; border: 1px solid var(--warning); border-radius: 10px; background: color-mix(in srgb, var(--warning) 8%, transparent); }
  .check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; }
  .check input { width: 18px; height: 18px; accent-color: var(--lime); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { min-width: 0; }
  .input { width: 100%; min-width: 0; }
  .row { display: flex; justify-content: flex-end; }
  .stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .clients { list-style: none; display: flex; flex-direction: column; gap: 12px; }
  .clients li { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
  .clients a { text-decoration: none; }
  .clients a:hover strong { text-decoration: underline; }
  .clients .muted { font-size: 13px; overflow-wrap: anywhere; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 480px) { .two { grid-template-columns: 1fr; } }
</style>
