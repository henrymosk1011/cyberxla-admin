<script lang="ts">
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import ReportPill from "../components/ReportPill.svelte";
  import { describeReport } from "../lib/activity.ts";
  import { dateTime } from "../lib/format.ts";
  import { blankComputer, contentProblem, dashFields, parseEmails, periodLabel, recalcKpis, reportActions, reportState, sendNowText } from "../lib/reports.ts";
  import { TONES, type AuditEntry, type Report, type ReportContent, type ReportPage, type ReportPatch, type ReportSettings, type Tone } from "../lib/types.ts";

  let { id }: { id: string } = $props();

  let report = $state<Report | null | undefined>(undefined);
  let settings = $state<ReportSettings | null>(null);
  let pages = $state<ReportPage[]>([]);
  let pagesFor = -1;
  let history = $state<AuditEntry[]>([]);
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let now = $state(Date.now());
  let confirm: Confirm;

  // What you are editing, and what was last loaded, to tell what changed.
  let draft = $state<ReportContent | null>(null);
  let mail = $state({ to: "", cc: "", subject: "", body: "" });
  let base = $state({ content: "", to: "", cc: "", subject: "", body: "" });
  let changedElsewhere = $state(false);
  let json = $state("");
  let jsonError = $state("");

  const TONE_LABEL: Record<Tone, string> = { good: "Good (green)", warn: "Needs attention (amber)", bad: "Problem (red)", info: "Note (gray)", lime: "Highlight (lime)" };
  const SEVERITIES = ["Critical", "Important", "Moderate", "Low"];

  // The form's checkboxes turn a missing flag into false; do the same up front
  // so a report you haven't touched doesn't look edited.
  const norm = (c: ReportContent): ReportContent => {
    // A snapshot, not structuredClone: c may be live state, which can't be cloned.
    const x = $state.snapshot(c) as ReportContent;
    x.kpis = x.kpis.map((k) => ({ ...k, highlight: !!k.highlight }));
    x.computers.list = x.computers.list.map((r) => ({ ...r, hidden: !!r.hidden }));
    return x;
  };

  function takeDrafts(r: Report) {
    draft = norm(r.content);
    mail = { to: r.recipients.join(", "), cc: r.cc.join(", "), subject: r.subject, body: r.email_body };
    base = { content: JSON.stringify(draft), to: mail.to, cc: mail.cc, subject: mail.subject, body: mail.body };
    changedElsewhere = false;
  }

  async function load(fresh = false) {
    try {
      const [r, s, h] = await Promise.all([db.report(id), db.reportSettings(), db.reportActivity(id)]);
      report = r;
      settings = s;
      history = h;
      if (!r) return;
      if (fresh || !dirty) takeDrafts(r);
      else if (JSON.stringify(norm(r.content)) !== base.content) changedElsewhere = true;
      if (r.rendered_version !== pagesFor) {
        pages = await db.reportPages(id);
        pagesFor = r.rendered_version;
      }
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load this report.";
    }
  }

  $effect(() => {
    void id;
    pagesFor = -1;
    load(true);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsub = db.subscribeReports(() => {
      clearTimeout(pending);
      pending = setTimeout(() => load(), 300);
    });
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => { unsub(); clearInterval(tick); clearTimeout(pending); };
  });

  const contentDirty = $derived(!!draft && JSON.stringify(draft) !== base.content);
  const mailDirty = $derived(mail.to !== base.to || mail.cc !== base.cc || mail.subject !== base.subject || mail.body !== base.body);
  const dirty = $derived(contentDirty || mailDirty);
  const st = $derived(report ? reportState(report, now) : null);
  const can = $derived(report ? reportActions(report, now) : null);
  const locked = $derived(!can?.edit);
  const rendering = $derived(!!report && report.content_version > report.rendered_version && !locked);
  const dashes = $derived(draft ? dashFields({ report: draft, email: { subject: mail.subject, body: mail.body } }) : []);
  const entries = $derived(history.map((a) => ({ a, text: describeReport(a) })).filter((e) => e.text));
  const shown = $derived(draft ? draft.computers.list.filter((c) => !c.hidden).length : 0);

  // Leaving with unsaved edits: ask first (links in the app, and closing the tab).
  $effect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = async (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href^='#']");
      if (!a || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute("href")!;
      if (await confirm.ask({ title: "Leave without saving?", body: "Your edits to this report haven't been saved.", action: "Leave", danger: true })) {
        base = { content: JSON.stringify(draft), ...mail };
        location.hash = href;
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); window.removeEventListener("click", onClick, true); };
  });

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

  async function save() {
    if (!report || !draft) return;
    error = "";
    const patch: ReportPatch = {};
    if (mailDirty) {
      const to = parseEmails(mail.to), cc = parseEmails(mail.cc);
      if (to.invalid.length || cc.invalid.length) return (error = `These don't look like email addresses: ${[...to.invalid, ...cc.invalid].join(", ")}`);
      if (!to.emails.length) return (error = "Add at least one recipient.");
      if (to.emails.length > 10 || cc.emails.length > 10) return (error = "Up to 10 recipients and 10 cc.");
      if (!mail.subject.trim()) return (error = "The email needs a subject.");
      if (!mail.body.trim()) return (error = "The email needs a body.");
      Object.assign(patch, { recipients: to.emails, cc: cc.emails, subject: mail.subject.trim(), email_body: mail.body.trim() });
    }
    if (contentDirty) {
      const problem = contentProblem(draft);
      if (problem) return (error = `The report can't be saved: ${problem}`);
      patch.content = $state.snapshot(draft) as ReportContent;
    }
    busy = true;
    notice = "";
    try {
      await db.updateReport(id, patch);
      notice = "Saved.";
      if (patch.content) {
        try {
          const res = await db.reportAction(id, "render");
          if (res.started) notice = "Saved. The preview updates in about a minute.";
        } catch (e) {
          error = `Saved, but the preview didn't start updating: ${e instanceof Error ? e.message : "try again"}.`;
        }
      }
      await load(true);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't save.";
    } finally {
      busy = false;
    }
  }

  function discard() {
    if (report) takeDrafts(report);
  }

  async function sendNow() {
    if (!report || !settings) return;
    if (dirty) return (error = "Save or discard your edits before sending.");
    if (await confirm.ask({ title: `Send ${report.client_name} now?`, body: sendNowText(report, settings.mode), action: "Send now" }))
      await act(() => db.reportAction(id, "send_now"), "Sending. It shows Sent in a minute or two.");
  }
  const setStatus = (status: Report["status"], ok: string) => act(() => db.updateReport(id, { status }), ok);
  async function cancelReport() {
    if (await confirm.ask({ title: "Cancel this report?", body: "It won't send. You can put it back on hold later.", action: "Cancel report", danger: true }))
      await setStatus("cancelled", "Cancelled. It won't send.");
  }
  async function markSent() {
    if (await confirm.ask({ title: "Mark as sent?", body: "Only if you found it in Sent Items of reports@cyberx.la (search for the subject).", action: "Mark as sent" }))
      await setStatus("sent", "Marked as sent.");
  }
  async function markNotSent() {
    if (await confirm.ask({ title: "Mark as not sent?", body: "Check Sent Items of reports@cyberx.la first, so the client doesn't get it twice. Then use Send now to try again.", action: "Mark as not sent" }))
      await setStatus("failed", "Marked as not sent. Use Send now to try again.");
  }
  async function remove() {
    if (!report) return;
    if (!(await confirm.ask({ title: "Delete this report?", body: report.is_test ? "Test reports can be deleted any time." : "It hasn't been sent. A new one is only made by running Generate reports again.", action: "Delete", danger: true }))) return;
    try {
      await db.deleteReport(id);
      base = { content: JSON.stringify(draft), ...mail };
      location.hash = "#/reports";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't delete.";
    }
  }
  async function retryRender() {
    await act(() => db.reportAction(id, "render"), "The preview is updating.");
  }

  async function download(kind: "client" | "internal") {
    if (!report) return;
    error = "";
    try {
      const b64 = await db.reportPdf(id, kind);
      if (!b64) return (error = "That PDF hasn't been made yet.");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      const stamp = report.period === "weekly" ? report.period_start : report.period_key;
      a.href = url;
      a.download = `${kind === "internal" ? "INTERNAL " : ""}${report.client_name} ${report.period === "weekly" ? "Weekly" : "Monthly"} Patch Report ${stamp}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't download.";
    }
  }

  function recalc() {
    if (draft) draft = recalcKpis(draft);
  }
  async function resetToGenerated() {
    if (!report) return;
    if (!(await confirm.ask({ title: "Reset to generated?", body: "Every edit to the report and the email subject and body goes back to what was generated on Sunday. Recipients stay. Nothing is saved until you press Save.", action: "Reset" }))) return;
    draft = norm(report.original.content);
    mail = { ...mail, subject: report.original.subject, body: report.original.email_body };
  }
  function loadJson() {
    json = JSON.stringify(draft, null, 2);
    jsonError = "";
  }
  function applyJson() {
    try {
      const parsed = JSON.parse(json);
      const problem = contentProblem(parsed);
      if (problem) return (jsonError = problem);
      draft = parsed;
      jsonError = "";
      notice = "JSON applied. Press Save to keep it.";
    } catch (e) {
      jsonError = `That isn't valid JSON: ${e instanceof Error ? e.message : ""}`;
    }
  }
  const move = <T,>(list: T[], i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
  };
  const pretty = (path: string) => path.replace(/^report\./, "").replace(/^email\.body$/, "email body").replace(/^email\.subject$/, "email subject");
</script>

<a class="back" href="#/reports">← All reports</a>

{#if report === undefined}
  <p class="muted">Loading…</p>
{:else if report === null || !draft || !st || !can}
  <p class="empty">{error || "This report doesn't exist or was deleted."}</p>
{:else}
  <header class="head">
    <div class="title">
      <p class="eyebrow">{periodLabel(report)} · {report.period_key}</p>
      <h1>{report.client_name}</h1>
      <div class="state">
        <ReportPill label={st.label} tone={st.tone} test={report.is_test} />
        <span class="muted">{st.note}</span>
      </div>
    </div>
    <div class="acts">
      {#if can.hold}<button class="btn" disabled={busy} onclick={() => setStatus("held", "On hold. It won't send until you resume it.")}>Hold</button>{/if}
      {#if can.resume}<button class="btn" disabled={busy} onclick={() => setStatus("scheduled", "Scheduled.")}>Resume</button>{/if}
      {#if can.sendNow}<button class="btn primary" disabled={busy || dirty} onclick={sendNow}>Send now</button>{/if}
      {#if can.markSent}<button class="btn" disabled={busy} onclick={markSent}>Mark as sent</button>{/if}
      {#if can.markNotSent}<button class="btn" disabled={busy} onclick={markNotSent}>Mark as not sent</button>{/if}
      {#if can.cancel}<button class="btn ghost" disabled={busy} onclick={cancelReport}>Cancel report</button>{/if}
      {#if can.remove}<button class="btn ghost del" disabled={busy} onclick={remove}>Delete</button>{/if}
    </div>
  </header>

  {#if error}<p class="error banner" role="alert">{error}</p>{/if}
  <p class="sr-only" role="status">{notice}</p>
  {#if notice}<p class="notice" aria-hidden="true">{notice}</p>{/if}

  {#if report.warnings.length}
    <div class="callout warn" role="note"><strong>Check before sending</strong>{#each report.warnings as w (w)}<p>{w}</p>{/each}</div>
  {/if}
  {#if report.status === "sent"}
    <div class="callout" role="note"><strong>This is what went out.</strong> <p>Sent {report.sent_at ? dateTime(report.sent_at) : ""} to {report.recipients.join(", ")}{report.cc.length ? `, cc ${report.cc.join(", ")}` : ""}. Sent reports can't be changed.</p></div>
  {:else if report.status === "sending"}
    <div class="callout warn" role="note"><strong>Sending.</strong> <p>It can't be edited while it goes out. If it doesn't finish, look in Sent Items of reports@cyberx.la for the subject below, then Mark as sent or Mark as not sent.</p></div>
  {/if}
  {#if changedElsewhere}
    <div class="callout warn" role="alert"><strong>This report changed somewhere else</strong> <p>Saving now replaces that change with yours. <button class="link" onclick={() => report && takeDrafts(report)}>Load the latest instead</button></p></div>
  {/if}
  {#if dashes.length}
    <div class="callout warn" role="note"><strong>Dashes found</strong> <p>House rule: no dashes as punctuation. Check {dashes.map(pretty).join(", ")}.</p></div>
  {/if}

  <div class="cols">
    <div class="main">
      <fieldset class="plain" disabled={locked || busy}>
        <section class="card">
          <div class="card-head"><h2>Email</h2><span class="sub">{settings?.mode === "live" && !report.is_test ? "Goes to the client" : "Preview: goes to you, tagged for these addresses"}</span></div>
          <div class="grid">
            <div class="field wide"><label for="m-to">To</label><input id="m-to" class="input" autocomplete="off" bind:value={mail.to} aria-describedby="m-to-h" /><span id="m-to-h" class="hint">Separate addresses with commas. Up to 10.</span></div>
            <div class="field wide"><label for="m-cc">Cc</label><input id="m-cc" class="input" autocomplete="off" bind:value={mail.cc} /></div>
            <div class="field wide"><label for="m-subject">Subject</label><input id="m-subject" class="input" maxlength="300" bind:value={mail.subject} /></div>
            <div class="field wide"><label for="m-body">Body</label><textarea id="m-body" class="input" rows="10" maxlength="20000" bind:value={mail.body} aria-describedby="m-body-h"></textarea><span id="m-body-h" class="hint">A blank line starts a new paragraph. **Two asterisks** make text bold. The PDF is attached.</span></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Top of the report</h2></div>
          <div class="grid">
            <div class="field"><label for="c-label">Label (top right, in capitals)</label><input id="c-label" class="input" bind:value={draft.label} /></div>
            <div class="field"><label for="c-title">Title</label><input id="c-title" class="input" bind:value={draft.title} /></div>
            <div class="field wide"><label for="c-sub">Subtitle</label><input id="c-sub" class="input" bind:value={draft.subtitle} /></div>
            <div class="field wide"><label for="c-head">Headline</label><textarea id="c-head" class="input" rows="2" bind:value={draft.headline}></textarea></div>
            <div class="field"><label for="c-pill">Status pill text (blank hides it)</label><input id="c-pill" class="input" bind:value={draft.pill.text} /></div>
            <div class="field"><label for="c-pill-tone">Status pill color</label><select id="c-pill-tone" class="input" bind:value={draft.pill.tone}>{#each TONES as t (t)}<option value={t}>{TONE_LABEL[t]}</option>{/each}</select></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Numbers</h2><button type="button" class="btn sm" onclick={recalc}>Recalculate from computers</button></div>
          <p class="hint top">Recalculate counts the computers table below ({shown} shown): managed, {draft.period === "weekly" ? "patched this week" : "patched every week"}, updates installed, need attention. It also sets the status pill.</p>
          {#each draft.kpis as k, i (i)}
            <div class="row3">
              <div class="field"><label for="k-{i}-v">Number {i + 1}</label><input id="k-{i}-v" class="input num" bind:value={k.value} /></div>
              <div class="field"><label for="k-{i}-l">Label</label><input id="k-{i}-l" class="input" bind:value={k.label} /></div>
              <label class="check"><input type="checkbox" bind:checked={k.highlight} /> Dark box</label>
            </div>
          {/each}
        </section>

        {#if draft.weeks}
          <section class="card">
            <div class="card-head"><h2>Patch success by week</h2></div>
            <div class="field"><label for="w-title">Section title</label><input id="w-title" class="input" bind:value={draft.weeks.title} /></div>
            {#each draft.weeks.bars as b, i (i)}
              <div class="row3">
                <div class="field"><label for="w-{i}-l">Week {i + 1} label</label><input id="w-{i}-l" class="input" bind:value={b.label} /></div>
                <div class="field"><label for="w-{i}-s">Under it</label><input id="w-{i}-s" class="input" bind:value={b.sub} /></div>
                <div class="field"><label for="w-{i}-p">Percent</label><input id="w-{i}-p" class="input num" type="number" min="0" max="100" bind:value={b.pct} /></div>
              </div>
            {/each}
          </section>
        {/if}

        <section class="card">
          <div class="card-head"><h2>What we did</h2><button type="button" class="btn sm" onclick={() => draft!.did.items.push({ title: "", text: "" })}>Add item</button></div>
          <div class="field"><label for="d-title">Section title</label><input id="d-title" class="input" bind:value={draft.did.title} /></div>
          {#each draft.did.items as it, i (i)}
            <div class="item">
              <div class="field"><label for="d-{i}-t">Item {i + 1}</label><input id="d-{i}-t" class="input" bind:value={it.title} /></div>
              <div class="field"><label for="d-{i}-x">Item {i + 1} detail</label><input id="d-{i}-x" class="input" bind:value={it.text} /></div>
              <button type="button" class="btn sm ghost" onclick={() => draft!.did.items.splice(i, 1)}>Remove<span class="sr-only"> item {i + 1}</span></button>
            </div>
          {/each}
        </section>

        <section class="card">
          <div class="card-head"><h2>Computers and updates</h2><button type="button" class="btn sm" onclick={() => draft!.computers.list.push(blankComputer())}>Add computer</button></div>
          <div class="grid">
            <div class="field"><label for="p-title">Table title</label><input id="p-title" class="input" bind:value={draft.computers.title} /></div>
            <div class="field"><label for="u-title">Updates section title</label><input id="u-title" class="input" bind:value={draft.updates_title} /></div>
          </div>
          <fieldset class="cols5">
            <legend>Column headings</legend>
            {#each draft.computers.columns as col, i (col.key)}
              <div class="field"><label for="col-{i}">Column {i + 1}</label><input id="col-{i}" class="input" bind:value={col.label} /></div>
            {/each}
          </fieldset>
          <ul class="pcs">
            {#each draft.computers.list as pc, i (i)}
              <li class:hiddenpc={pc.hidden}>
                <details>
                  <summary><strong>{pc.name || "Unnamed"}</strong> <span class="muted">{pc.run} · {pc.status}{pc.hidden ? " · hidden" : ""} · {pc.updates.count} {pc.updates.count === 1 ? "update" : "updates"}</span></summary>
                  <div class="pc">
                    <div class="grid">
                      <div class="field"><label for="pc-{i}-n">Name</label><input id="pc-{i}-n" class="input" bind:value={pc.name} /></div>
                      <div class="field"><label for="pc-{i}-r">{draft.computers.columns[1]?.label ?? "Run"}</label><input id="pc-{i}-r" class="input" bind:value={pc.run} /></div>
                      <div class="field"><label for="pc-{i}-q">{draft.computers.columns[2]?.label ?? "Updates queued"}</label><input id="pc-{i}-q" class="input" bind:value={pc.pending} /></div>
                      <div class="field"><label for="pc-{i}-c">{draft.computers.columns[3]?.label ?? "Critical risks"}</label><input id="pc-{i}-c" class="input" bind:value={pc.crit} /></div>
                      <div class="field"><label for="pc-{i}-s">{draft.computers.columns[4]?.label ?? "Status"}</label><input id="pc-{i}-s" class="input" bind:value={pc.status} /></div>
                      <div class="field"><label for="pc-{i}-t">Status color</label><select id="pc-{i}-t" class="input" bind:value={pc.tone}>{#each TONES as t (t)}<option value={t}>{TONE_LABEL[t]}</option>{/each}</select></div>
                    </div>
                    <label class="check"><input type="checkbox" bind:checked={pc.hidden} /> Hide this computer from the report</label>
                    <fieldset class="updates">
                      <legend>Updates installed on {pc.name || "this computer"}</legend>
                      <div class="grid">
                        <div class="field"><label for="pc-{i}-uc">Count shown</label><input id="pc-{i}-uc" class="input num" type="number" min="0" bind:value={pc.updates.count} /></div>
                        <div class="field"><label for="pc-{i}-ue">Text when there are none</label><input id="pc-{i}-ue" class="input" bind:value={pc.updates.empty} /></div>
                      </div>
                      {#each pc.updates.items as u, j (j)}
                        <div class="upd">
                          <div class="field grow"><label for="pc-{i}-u{j}-n">Update {j + 1}</label><input id="pc-{i}-u{j}-n" class="input" bind:value={u.name} /></div>
                          <div class="field"><label for="pc-{i}-u{j}-c">Times</label><input id="pc-{i}-u{j}-c" class="input num" type="number" min="1" bind:value={u.count} /></div>
                          <div class="field"><label for="pc-{i}-u{j}-s">Severity tag</label><select id="pc-{i}-u{j}-s" class="input" bind:value={u.severity}><option value={null}>None</option>{#each SEVERITIES.includes(u.severity ?? "") || !u.severity ? SEVERITIES : [...SEVERITIES, u.severity] as sv (sv)}<option value={sv}>{sv}</option>{/each}</select></div>
                          <button type="button" class="btn sm ghost" onclick={() => pc.updates.items.splice(j, 1)}>Remove<span class="sr-only"> update {j + 1} from {pc.name}</span></button>
                        </div>
                      {/each}
                      <button type="button" class="btn sm" onclick={() => pc.updates.items.push({ name: "", count: 1, severity: null })}>Add update<span class="sr-only"> to {pc.name}</span></button>
                    </fieldset>
                    <div class="pcacts">
                      <button type="button" class="btn sm ghost" disabled={i === 0} onclick={() => move(draft!.computers.list, i, -1)}>Move up<span class="sr-only"> {pc.name}</span></button>
                      <button type="button" class="btn sm ghost" disabled={i === draft.computers.list.length - 1} onclick={() => move(draft!.computers.list, i, 1)}>Move down<span class="sr-only"> {pc.name}</span></button>
                      <button type="button" class="btn sm ghost del" onclick={() => draft!.computers.list.splice(i, 1)}>Delete computer<span class="sr-only"> {pc.name}</span></button>
                    </div>
                  </div>
                </details>
              </li>
            {/each}
          </ul>
        </section>

        <section class="card">
          <div class="card-head"><h2>Open security risks</h2><button type="button" class="btn sm" onclick={() => draft!.security.apps.push({ name: "", detail: "on 1 computer" })}>Add app</button></div>
          <div class="field"><label for="s-title">Section title</label><input id="s-title" class="input" bind:value={draft.security.title} /></div>
          <div class="field"><label for="s-text">Text</label><textarea id="s-text" class="input" rows="4" bind:value={draft.security.text}></textarea></div>
          <div class="field"><label for="s-intro">Before the app list</label><input id="s-intro" class="input" bind:value={draft.security.apps_intro} /></div>
          {#each draft.security.apps as a, i (i)}
            <div class="item">
              <div class="field"><label for="s-{i}-n">App {i + 1}</label><input id="s-{i}-n" class="input" bind:value={a.name} /></div>
              <div class="field"><label for="s-{i}-d">App {i + 1} detail</label><input id="s-{i}-d" class="input" bind:value={a.detail} /></div>
              <button type="button" class="btn sm ghost" onclick={() => draft!.security.apps.splice(i, 1)}>Remove<span class="sr-only"> app {i + 1}</span></button>
            </div>
          {/each}
          <div class="field"><label for="s-note">Closing note</label><textarea id="s-note" class="input" rows="2" bind:value={draft.security.note}></textarea></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Next patch window</h2></div>
          <div class="grid">
            <div class="field"><label for="n-label">Label</label><input id="n-label" class="input" bind:value={draft.next_window.label} /></div>
            <div class="field"><label for="n-when">When</label><input id="n-when" class="input" bind:value={draft.next_window.when} /></div>
            <div class="field wide"><label for="n-note">Note</label><textarea id="n-note" class="input" rows="2" bind:value={draft.next_window.note}></textarea></div>
          </div>
        </section>

        <section class="card">
          <details ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadJson()}>
            <summary><h2 class="inline">Advanced: raw JSON</h2></summary>
            <p class="hint top">Everything above, plus anything they don't show. Apply checks it, then Save keeps it.</p>
            <label class="sr-only" for="raw">Report content as JSON</label>
            <textarea id="raw" class="input mono" rows="18" spellcheck="false" bind:value={json} aria-describedby={jsonError ? "raw-err" : undefined}></textarea>
            {#if jsonError}<p id="raw-err" class="error" role="alert">{jsonError}</p>{/if}
            <div class="rowbtns">
              <button type="button" class="btn sm ghost" onclick={loadJson}>Reload from the form</button>
              <button type="button" class="btn sm" onclick={applyJson}>Apply JSON</button>
            </div>
          </details>
          <div class="reset">
            <p class="hint">Undo every edit to the report, subject and body.</p>
            <button type="button" class="btn sm" onclick={resetToGenerated}>Reset to generated</button>
          </div>
        </section>
      </fieldset>

      {#if entries.length}
        <section class="card">
          <div class="card-head"><h2>History</h2></div>
          <ol class="timeline">
            {#each entries as e (e.a.id)}<li><span class="dot" aria-hidden="true"></span><div><p>{e.text}</p><span class="muted small">{dateTime(e.a.at)}{e.a.actor_role === "report_writer" ? " · automatic" : ""}</span></div></li>{/each}
          </ol>
        </section>
      {/if}
    </div>

    <aside class="side">
      <section class="card preview">
        <div class="card-head">
          <h2>Preview</h2>
          <span class="sub" role="status">
            {#if report.render_error && rendering}Preview failed{:else if rendering}Updating, about a minute{:else if pages.length}Matches the last save{/if}
          </span>
        </div>
        {#if report.render_error && rendering}
          <p class="error">The PDF couldn't be built: {report.render_error}</p>
          <button class="btn sm" disabled={busy} onclick={retryRender}>Try again</button>
        {/if}
        {#if pages.length}
          <!-- On narrow screens the pages scroll sideways, so keyboard users need to be able to focus the strip. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="pages" class:stale={rendering} role="region" aria-label="Preview pages" tabindex="0">
            {#each pages as p (p.page)}
              <img src={p.src} alt="Page {p.page} of {pages.length} of the client PDF" loading="lazy" width="935" height="1210" />
            {/each}
          </div>
        {:else if report.status === "sent"}
          <p class="muted">Sent reports keep the PDF only. Download it below.</p>
        {:else}
          <p class="muted">No preview yet. It appears once the PDF is built.</p>
        {/if}
        <div class="dl">
          <button class="btn sm" onclick={() => download("client")}>Download PDF</button>
          <button class="btn sm ghost" onclick={() => download("internal")}>Internal PDF</button>
        </div>
      </section>
    </aside>
  </div>

  {#if dirty && !locked}
    <div class="savebar" role="region" aria-label="Unsaved changes">
      <span>Unsaved changes{contentDirty ? " (the preview updates after you save)" : ""}</span>
      <div>
        <button class="btn ghost" disabled={busy} onclick={discard}>Discard</button>
        <button class="btn primary" disabled={busy} onclick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  {/if}
{/if}

<Confirm bind:this={confirm} />

<style>
  .back { display: inline-block; font-size: 13px; color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .title { min-width: 0; }
  h1 { font-size: 32px; letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 10px; overflow-wrap: anywhere; }
  .state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 14px; }
  .state .muted { color: var(--text-2); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .del { color: var(--critical); }
  .banner { margin-bottom: 12px; }
  .notice { margin-bottom: 12px; font-size: 14px; color: var(--good-text); }
  .callout { border: 1px solid var(--line-2); border-left: 3px solid var(--text-2); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; font-size: 14px; background: var(--surface); }
  .callout.warn { border-left-color: var(--warning); }
  .callout p { margin-top: 2px; color: var(--text-2); }
  .link { background: none; border: 0; padding: 0; color: var(--lime); font-weight: 600; text-decoration: underline; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); gap: 16px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .side { position: sticky; top: 16px; min-width: 0; }
  fieldset.plain { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  fieldset.plain:disabled .card { opacity: 0.75; }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head { margin-bottom: 0; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .wide { grid-column: 1 / -1; }
  .field { min-width: 0; }
  .input { width: 100%; min-width: 0; }
  .num { font-variant-numeric: tabular-nums; }
  .mono { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; }
  .hint { font-size: 12.5px; color: var(--muted); }
  .hint.top { margin-top: -4px; }
  .row3 { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; gap: 12px; align-items: end; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-2); min-height: 42px; }
  .check input { width: 18px; height: 18px; accent-color: var(--lime); }
  .item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 12px; align-items: end; }
  fieldset.cols5 { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  fieldset legend { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .pcs { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .pcs li { border: 1px solid var(--line); border-radius: 10px; }
  .pcs li.hiddenpc summary strong { text-decoration: line-through; color: var(--muted); }
  summary { cursor: pointer; padding: 12px 14px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
  summary .muted { font-size: 13px; }
  .pc { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 12px; }
  fieldset.updates { border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .upd { display: grid; grid-template-columns: minmax(0, 1fr) 80px 150px auto; gap: 10px; align-items: end; }
  .pcacts { display: flex; flex-wrap: wrap; gap: 6px; }
  .inline { display: inline; font-size: 15px; font-weight: 600; }
  details > summary h2 { margin: 0; }
  .rowbtns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .reset { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; flex-wrap: wrap; }
  .timeline { list-style: none; display: flex; flex-direction: column; gap: 12px; }
  .timeline li { display: flex; gap: 12px; font-size: 13px; }
  .timeline .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--axis); flex: none; }
  .small { font-size: 12px; }
  .preview .sub { font-size: 13px; color: var(--text-2); }
  .pages { display: flex; flex-direction: column; gap: 10px; transition: opacity 0.3s; }
  .pages.stale { opacity: 0.55; }
  .pages img { width: 100%; height: auto; border-radius: 6px; background: #fff; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); }
  .dl { display: flex; gap: 8px; flex-wrap: wrap; }
  .savebar { position: sticky; bottom: 12px; z-index: 10; margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--lime); border-radius: 14px; background: var(--surface-2); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); font-size: 14px; font-weight: 600; }
  .savebar div { display: flex; gap: 8px; }
  @media (max-width: 1100px) {
    .cols { grid-template-columns: 1fr; }
    .side { position: static; order: -1; }
    .pages { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; }
    .pages img { width: min(340px, 80vw); flex: none; scroll-snap-align: start; }
  }
  @media (max-width: 640px) {
    h1 { font-size: 26px; }
    .grid, .row3, .item, .upd { grid-template-columns: 1fr; }
    fieldset.cols5 { grid-template-columns: 1fr 1fr; }
    .check { min-height: 0; }
  }
</style>
