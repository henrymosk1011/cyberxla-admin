<script lang="ts">
  import db from "$db";
  import Icon from "../components/Icon.svelte";
  import Confirm from "../components/Confirm.svelte";
  import Menu from "../components/Menu.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import GradePill from "../components/GradePill.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import LoadState from "../components/LoadState.svelte";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { dateTime, shortDate } from "../lib/format.ts";
  import { remediationFor } from "../lib/remediation.ts";
  import { FINDING_SEVERITIES, type Audit, type AuditFinding, type AuditSettings, type FindingSeverity, type Prospect, type ReportPage } from "../lib/types.ts";

  let { id, version, onchanged }: { id: string; version: number; onchanged?: () => void } = $props();

  let audit = $state<Audit | null | undefined>(undefined);
  let prospect = $state<Prospect | null>(null);
  let pages = $state<ReportPage[]>([]);
  let settings = $state<AuditSettings | null>(null);
  let loadError = $state("");
  let busy = $state(false);

  // Editable email fields (seeded from the audit, saved on demand).
  let subject = $state("");
  let body = $state("");
  let recips = $state("");
  let confirm: Confirm;

  const SEV_LABEL: Record<FindingSeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
  const locked = $derived(audit ? audit.delivery === "sending" || audit.delivery === "sent" : true);
  const emailDirty = $derived(!!audit && (subject !== (audit.subject ?? "") || body !== (audit.email_body ?? "") || recips !== (audit.recipients ?? []).join(", ")));
  const problems = $derived((audit?.findings ?? []).filter((f) => !f.passed));
  const passed = $derived((audit?.findings ?? []).filter((f) => f.passed));
  const grouped = $derived(FINDING_SEVERITIES.map((sev) => ({ sev, items: problems.filter((f) => f.severity === sev) })).filter((g) => g.items.length));

  async function load() {
    try {
      const a = await db.audit(id);
      audit = a;
      if (a) {
        subject = a.subject ?? ""; body = a.email_body ?? ""; recips = (a.recipients ?? []).join(", ");
        [prospect, pages, settings] = await Promise.all([db.prospect(a.prospect_id), a.rendered_version > 0 ? db.auditPages(id) : Promise.resolve([]), db.auditSettings()]);
      }
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (audit === undefined) loadError = m; else toast.error(`Couldn't refresh this audit. ${m}`);
    }
  }
  $effect(() => { void id; void version; load(); });

  async function act(action: "rescan" | "rebuild" | "send_now" | "copy" | "cancel", okMsg: string, failMsg: string) {
    busy = true;
    try {
      await db.auditAction(id, action);
      toast.success(okMsg);
      onchanged?.();
      await load();
    } catch (e) {
      toast.error(messageOf(e, failMsg));
    } finally { busy = false; }
  }
  async function sendNow() {
    if (!audit) return;
    const live = settings?.mode === "live" && !audit.is_test;
    const to = live ? (audit.recipients.length ? audit.recipients.join(", ") : "the prospect") : "henry@cyberx.la";
    const warn = live
      ? `This emails the report to ${to}. Make sure the findings and wording are right first.`
      : `Preview mode is on, so this goes to henry@cyberx.la only (not the prospect). Turn on live mode in Settings to send to prospects.`;
    if (!(await confirm.ask({ title: "Send this audit report?", body: warn, action: live ? "Send to prospect" : "Send me the preview", danger: live }))) return;
    await act("send_now", live ? "Report sent." : "Preview sent to henry@cyberx.la.", "Couldn't send the report.");
  }
  async function saveEmail() {
    if (!audit) return;
    busy = true;
    try {
      const recipients = recips.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      await db.updateAudit(id, { subject: subject.trim() || null, email_body: body, recipients });
      toast.success("Saved.");
      onchanged?.();
      await load();
    } catch (e) { toast.error(messageOf(e, "Couldn't save the email.")); }
    finally { busy = false; }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy it. Select the text and copy it by hand.");
    }
  }
  async function del() {
    if (!audit) return;
    if (!(await confirm.ask({ title: "Delete this audit?", body: "Permanently deletes this audit and its report. A sent audit can't be deleted. This can't be undone.", action: "Delete", danger: true }))) return;
    try {
      const pid = audit.prospect_id;
      await db.deleteAudit(id);
      toast.success("Audit deleted.");
      onchanged?.();
      location.hash = `#/prospects/${pid}`;
    } catch (e) { toast.error(messageOf(e, "Couldn't delete the audit.")); }
  }
</script>

{#if audit === undefined}
  <LoadState error={loadError} what="this audit" onretry={() => { loadError = ""; load(); }} />
{:else if audit === null}
  <p class="empty">This audit doesn't exist or was deleted.</p>
{:else}
  {@const a = audit}
  <a class="back" href={prospect ? `#/prospects/${a.prospect_id}` : "#/prospects"}><Icon name="arrow-left" size={14} /> {prospect?.business_name ?? "Prospect"}</a>

  <PageHeader eyebrow={`${a.kind === "active" ? "Active" : "Passive"} audit${a.is_test ? " · test" : ""} · ${dateTime(a.created_at)}`} title={prospect?.business_name ?? a.target_domain ?? "Audit"}>
    {#snippet meta()}
      <p class="contact">
        {#if a.target_url}<a href={a.target_url} target="_blank" rel="noopener noreferrer">{a.target_domain ?? a.target_url}</a>{/if}
        {#if a.scanner_version}<span>scanner {a.scanner_version}</span>{/if}
      </p>
    {/snippet}
    <div class="headacts">
      {#if a.scan_status === "done"}
        <button class="btn sm" disabled={busy || locked} onclick={() => act("rescan", "Re-scan started.", "Couldn't start the scan.")}>Re-scan</button>
        <button class="btn sm" disabled={busy} onclick={() => act("rebuild", "PDF rebuild started.", "Couldn't rebuild the PDF.")}>Rebuild PDF</button>
      {:else if a.scan_status === "failed"}
        <button class="btn primary sm" disabled={busy} onclick={() => act("rescan", "Scan started.", "Couldn't start the scan.")}>Try again</button>
      {:else if a.scan_status === "queued" || a.scan_status === "running"}
        <button class="btn sm" disabled={busy} onclick={() => act("cancel", "Audit cancelled.", "Couldn't cancel.")}>Cancel</button>
      {/if}
      <Menu label="More actions for this audit" items={[{ label: "Send me a copy", onselect: () => act("copy", "A copy is on its way to henry@cyberx.la.", "Couldn't send the copy.") }, { label: "Delete audit", danger: true, onselect: del }]} />
    </div>
  </PageHeader>

  <!-- Scan status / result header -->
  {#if a.scan_status === "done"}
    <section class="card result">
      <GradePill grade={a.grade} score={a.score} size="lg" />
      <div class="result-txt">
        <strong>{a.summary ?? "Audit complete."}</strong>
        <span class="muted small">{problems.length} {problems.length === 1 ? "issue" : "issues"} found · {passed.length} {passed.length === 1 ? "check" : "checks"} passed{#if a.finished_at}{` · scanned ${shortDate(a.finished_at)}`}{/if}</span>
      </div>
      <div class="result-delivery">
        {#if a.delivery === "sent"}<span class="sent"><Icon name="check" size={14} /> Report sent {a.sent_at ? shortDate(a.sent_at) : ""}</span>
        {:else if a.delivery === "sending"}<span class="muted">Sending…</span>
        {:else if a.delivery === "failed"}<span class="bad">Send failed</span>{/if}
      </div>
    </section>
  {:else}
    <section class="card scanstate">
      <StatusPill status={a.scan_status} />
      <p class="muted">
        {#if a.scan_status === "queued"}Queued. The scanner will pick this up shortly.
        {:else if a.scan_status === "running"}Scanning the public posture now.
        {:else if a.scan_status === "failed"}{a.scan_error ?? "The scan failed."}
        {:else if a.scan_status === "cancelled"}This audit was cancelled.{/if}
      </p>
    </section>
  {/if}

  {#if a.scan_status === "done"}
    <div class="cols">
      <div class="main">
        <!-- Findings -->
        <section class="card">
          <div class="card-head"><h2>Findings</h2></div>
          {#if problems.length}
            {#each grouped as g (g.sev)}
              <h3 class="sev sev-{g.sev}">{SEV_LABEL[g.sev]} <span class="muted">· {g.items.length}</span></h3>
              <ul class="findings">
                {#each g.items as f (f.id)}{@render finding(f)}{/each}
              </ul>
            {/each}
          {:else}
            <p class="empty">No issues found. Nice and tidy.</p>
          {/if}
          {#if passed.length}
            <h3 class="sev sev-info">Already in good shape <span class="muted">· {passed.length}</span></h3>
            <ul class="findings passed">
              {#each passed as f (f.id)}
                <li class="finding ok"><div class="f-head"><Icon name="check" size={14} /><strong>{f.title}</strong></div>{#if f.detail}<p class="muted">{f.detail}</p>{/if}</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>

      <aside class="side">
        <!-- Outgoing email -->
        <section class="card">
          <div class="card-head"><h2>Report email</h2></div>
          {#if settings?.mode === "preview"}
            <p class="mode preview">Preview mode: sends to henry@cyberx.la only. Prospects are never emailed until you turn on live mode in <a href="#/prospects/settings">Settings</a>.</p>
          {:else}
            <p class="mode live">Live mode: Send emails the report to the prospect.</p>
          {/if}
          <label class="lbl" for="au-to">To</label>
          <input id="au-to" class="input" bind:value={recips} disabled={locked} placeholder="owner@example.com" />
          <label class="lbl" for="au-subj">Subject</label>
          <input id="au-subj" class="input" bind:value={subject} disabled={locked} maxlength="300" />
          <label class="lbl" for="au-body">Message</label>
          <textarea id="au-body" class="input body" bind:value={body} disabled={locked} maxlength="20000" rows="8"></textarea>
          <div class="emailacts">
            <button class="btn sm" disabled={busy || locked || !emailDirty} onclick={saveEmail}>{emailDirty ? "Save changes" : "Saved"}</button>
            <button class="btn sm" disabled={busy} onclick={() => act("copy", "A copy is on its way to henry@cyberx.la.", "Couldn't send the copy.")}>Send me a copy</button>
            <button class="btn primary sm" disabled={busy || locked || a.delivery === 'sent'} onclick={sendNow}>{a.delivery === "sent" ? "Sent" : "Send"}</button>
          </div>
        </section>

        <!-- Scan details -->
        <section class="card">
          <div class="card-head"><h2>Scan details</h2></div>
          <dl class="meta">
            <dt>Target</dt><dd>{a.target_domain ?? "—"}</dd>
            {#if typeof a.meta?.ip === "string"}<dt>Resolved IP</dt><dd>{a.meta.ip}</dd>{/if}
            {#if a.meta?.tls && typeof a.meta.tls === "object"}<dt>Certificate</dt><dd>{(a.meta.tls as Record<string, unknown>).issuer ?? ""} · {(a.meta.tls as Record<string, unknown>).days_left ?? "?"} days left</dd>{/if}
            <dt>Scanned</dt><dd>{a.finished_at ? dateTime(a.finished_at) : "—"}</dd>
          </dl>
        </section>

        <!-- PDF preview -->
        <section class="card">
          <div class="card-head"><h2>Report PDF</h2></div>
          {#if pages.length}
            <div class="pdf">{#each pages as pg (pg.page)}<img src={pg.src} alt="Report page {pg.page}" loading="lazy" />{/each}</div>
          {:else}
            <p class="empty">The branded PDF renders when the scanner connects. It's attached to the email the prospect receives.</p>
          {/if}
        </section>
      </aside>
    </div>
  {/if}
{/if}

{#snippet finding(f: AuditFinding)}
  {@const fix = remediationFor(f.id)}
  <li class="finding">
    <div class="f-head"><span class="dot sev-{f.severity}" aria-hidden="true"></span><strong>{f.title}</strong><span class="cat">{f.category}</span></div>
    {#if f.detail}<p>{f.detail}</p>{/if}
    {#if fix}
      <details class="fix">
        <summary>How to fix<span class="fixmeta">{fix.effort}</span></summary>
        <div class="fixbody">
          <p class="fixlede">{fix.summary}</p>
          <p class="fixwho"><span class="muted">Who does it:</span> {fix.who}</p>
          <ol class="steps">{#each fix.steps as s, i (i)}<li>{s}</li>{/each}</ol>
          {#if fix.snippet}
            <div class="snip">
              <div class="snip-head"><span class="muted">{fix.snippet.label}</span><button type="button" class="copy" onclick={() => copy(fix.snippet!.code)}>Copy</button></div>
              <code class="snip-code">{fix.snippet.code}</code>
            </div>
          {/if}
          {#if fix.providers}
            <div class="provs">
              <span class="provlabel muted">Exact steps for your provider</span>
              {#each fix.providers as pv (pv.name)}
                <details class="prov">
                  <summary>{pv.name}</summary>
                  <ol class="steps">{#each pv.steps as s, i (i)}<li>{s}</li>{/each}</ol>
                </details>
              {/each}
            </div>
          {/if}
          {#if fix.verify}<p class="verify"><Icon name="check" size={13} /> <span>{fix.verify}</span></p>{/if}
          {#if fix.learn}<p class="learnline">{#each fix.learn as l, i (l.url)}{#if i > 0} · {/if}<a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>{/each}</p>{/if}
        </div>
      </details>
    {:else if f.recommendation}
      <p class="rec"><span class="muted">Fix:</span> {f.recommendation}</p>
    {/if}
  </li>
{/snippet}

<Confirm bind:this={confirm} />

<style>
  .headacts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .result { display: flex; align-items: center; gap: 16px; }
  .result-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .result-txt strong { font-weight: 600; font-size: var(--fs-lg); }
  .result-delivery { flex: none; }
  .sent { color: var(--good-text); display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: var(--fs-sm); }
  .bad { color: #ff6b6b; }
  .small { font-size: var(--fs-xs); }
  .scanstate { display: flex; align-items: center; gap: 14px; }
  .scanstate p { margin: 0; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; margin-top: 20px; }
  .main { min-width: 0; }
  .side { display: flex; flex-direction: column; gap: 20px; }
  .sev { font-size: var(--fs-sm); font-weight: 700; letter-spacing: 0.02em; margin: 18px 0 8px; }
  .sev:first-of-type { margin-top: 4px; }
  .sev-critical { color: #ff6b6b; }
  .sev-high { color: #ff8f5a; }
  .sev-medium { color: var(--warning); }
  .sev-low { color: var(--text-2); }
  .sev-info { color: var(--muted); }
  .findings { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .finding { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--ink); }
  .finding.ok { background: color-mix(in srgb, var(--good) 6%, var(--ink)); border-color: color-mix(in srgb, var(--good) 22%, var(--line)); }
  .finding.ok .f-head { color: var(--good-text); }
  .f-head { display: flex; align-items: center; gap: 8px; }
  .f-head strong { font-weight: 600; flex: 1; min-width: 0; }
  .cat { font-size: var(--fs-xs); color: #ff6b6b; text-transform: uppercase; letter-spacing: 0.06em; }
  .finding p { margin-top: 6px; font-size: var(--fs-sm); color: var(--text-2); }
  .finding .rec { color: var(--text); }

  /* How to fix: a collapsed accordion per finding, with provider sub-steps. */
  .fix { margin-top: 10px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--ink); }
  .fix > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: var(--fs-sm); font-weight: 600; color: var(--text); user-select: none; border-radius: var(--radius-sm); }
  .fix > summary::-webkit-details-marker { display: none; }
  .fix > summary::after { content: ""; width: 7px; height: 7px; margin-left: auto; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s; }
  .fix[open] > summary::after { transform: rotate(225deg); }
  .fix > summary:hover { background: color-mix(in srgb, var(--lime) 7%, transparent); }
  .fix > summary:focus-visible { outline: 2px solid var(--lime); outline-offset: -2px; }
  .fixmeta { font-weight: 400; color: var(--muted); font-size: var(--fs-xs); }
  .fixbody { padding: 2px 12px 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
  .fixlede { margin-top: 10px; font-size: var(--fs-sm); color: var(--text); }
  .fixwho { font-size: var(--fs-xs); color: var(--text-2); margin: 0; }
  .steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-sm); color: var(--text-2); }
  .steps li { padding-left: 3px; }
  .snip { border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden; }
  .snip-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px 6px 10px; border-bottom: 1px solid var(--line); }
  .snip-head .muted { font-size: var(--fs-xs); }
  .snip-code { display: block; padding: 10px; font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); line-height: 1.5; color: var(--lime); white-space: pre-wrap; overflow-wrap: anywhere; }
  .copy { flex: none; border: 1px solid var(--line-2); background: var(--ink); color: var(--text); border-radius: var(--radius-sm); padding: 3px 10px; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
  .copy:hover { border-color: var(--lime); color: var(--lime); }
  .provs { display: flex; flex-direction: column; gap: 5px; }
  .provlabel { font-size: var(--fs-xs); font-weight: 600; }
  .prov { border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .prov > summary { cursor: pointer; list-style: none; display: flex; align-items: center; padding: 7px 10px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-2); }
  .prov > summary::-webkit-details-marker { display: none; }
  .prov > summary::after { content: ""; width: 6px; height: 6px; margin-left: auto; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s; }
  .prov[open] > summary::after { transform: rotate(225deg); }
  .prov > summary:hover { color: var(--text); }
  .prov > summary:focus-visible { outline: 2px solid var(--lime); outline-offset: -2px; }
  .prov .steps { padding: 0 12px 10px 30px; font-size: var(--fs-xs); }
  .verify { display: flex; gap: 7px; align-items: flex-start; margin: 0; font-size: var(--fs-xs); color: var(--good-text); background: color-mix(in srgb, var(--good) 8%, transparent); border: 1px solid color-mix(in srgb, var(--good) 24%, var(--line)); border-radius: var(--radius-sm); padding: 8px 10px; }
  .verify :global(svg) { flex: none; margin-top: 1px; }
  .learnline { font-size: var(--fs-xs); margin: 0; }
  .learnline a { color: var(--lime); }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.sev-critical { background: #ff6b6b; }
  .dot.sev-high { background: #ff8f5a; }
  .dot.sev-medium { background: var(--warning); }
  .dot.sev-low { background: var(--st-contacted); }
  .dot.sev-info { background: var(--muted); }
  .mode { font-size: var(--fs-sm); padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 12px; }
  .mode.preview { background: color-mix(in srgb, var(--warning) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent); color: var(--text); }
  .mode.live { background: color-mix(in srgb, var(--good) 12%, transparent); border: 1px solid color-mix(in srgb, var(--good) 35%, transparent); color: var(--text); }
  .lbl { display: block; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
  .body { resize: vertical; min-height: 120px; font-family: inherit; }
  .emailacts { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; flex-wrap: wrap; }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: var(--fs-sm); }
  .meta dt { color: var(--muted); }
  .meta dd { color: var(--text); overflow-wrap: anywhere; }
  .pdf { display: flex; flex-direction: column; gap: 10px; }
  .pdf img { width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }
</style>
