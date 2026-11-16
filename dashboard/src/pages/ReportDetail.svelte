<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { onDestroy, tick } from "svelte";
  import db from "$db";
  import ActivityCard from "../components/ActivityCard.svelte";
  import Confirm from "../components/Confirm.svelte";
  import Menu, { type MenuItem } from "../components/Menu.svelte";
  import DidItems from "../components/DidItems.svelte";
  import PageLightbox from "../components/PageLightbox.svelte";
  import ReportPill from "../components/ReportPill.svelte";
  import LoadState from "../components/LoadState.svelte";
  import SaveBar from "../components/SaveBar.svelte";
  import { guardUnsaved, pageHeading } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { describeReport } from "../lib/activity.ts";
  import { resolveTemplate } from "../lib/template.ts";
  import { dateTime, shortDate } from "../lib/format.ts";
  import { blankComputer, contentProblem, dashFields, isLeftOff, parseEmails, periodLabel, recalcKpis, reportActions, reportState, sendNowText, withName } from "../lib/reports.ts";
  import { TONES, type AuditEntry, type Client, type Report, type ReportContent, type ReportPage, type ReportPatch, type ReportSettings, type Tone, type UnifiStatus } from "../lib/types.ts";

  let { id }: { id: string } = $props();

  let report = $state<Report | null | undefined>(undefined);
  /** The report's client, for its always leave off list. */
  let client = $state<Client | null>(null);
  let settings = $state<ReportSettings | null>(null);
  let pages = $state<ReportPage[]>([]);
  let pagesFor = "";
  // Rebuild pressed: the build time and error it started from, so we can tell when it's done.
  let rebuild = $state<{ at: string | null; err: string | null; started: number } | null>(null);
  let history = $state<AuditEntry[]>([]);
  let loadError = $state("");
  // How the last Save went, shown in the save bar (always on screen).
  let saveError = $state("");
  let saveDone = $state("");
  let busy = $state(false);
  let now = $state(Date.now());
  let confirm: Confirm;
  let lightbox = $state<PageLightbox>();

  // What you are editing, and what was last loaded, to tell what changed.
  let draft = $state<ReportContent | null>(null);
  let mail = $state({ to: "", cc: "", subject: "", body: "" });
  let base = $state({ content: "", to: "", cc: "", subject: "", body: "" });
  let changedElsewhere = $state(false);
  let json = $state("");
  let jsonError = $state("");

  // The page's sections, as tabs. The last one you used is remembered in this browser.
  type TabId = "text" | "computers" | "email" | "unifi" | "history" | "advanced";
  const TAB_IDS: TabId[] = ["text", "computers", "email", "unifi", "history", "advanced"];
  function savedTab(): TabId {
    try {
      const t = localStorage.getItem("report.tab");
      if (t && (TAB_IDS as string[]).includes(t)) return t as TabId;
    } catch { /* storage off: start on the first tab */ }
    return "text";
  }
  let tab = $state<TabId>(savedTab());
  function pick(t: TabId) {
    tab = t;
    try { localStorage.setItem("report.tab", t); } catch { /* not remembered; fine */ }
  }

  // UniFi: the client's latest status, and Check now.
  let unifi = $state<UnifiStatus | null>(null);
  let unifiLoaded = $state(false);
  let unifiChecking = $state(false);
  let unifiMsg = $state("");
  let gone = false;
  onDestroy(() => (gone = true));

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
      const before = client?.id;
      client = await db.client(r.client_id);
      if (client && (client.id !== before || !unifiLoaded)) loadUnifi();
      if (fresh || !dirty) takeDrafts(r);
      else if (JSON.stringify(norm(r.content)) !== base.content) changedElsewhere = true;
      // A Rebuild keeps the version but changes the build time, so key on both.
      const builtKey = `${r.rendered_version} ${r.rendered_at ?? ""}`;
      if (builtKey !== pagesFor) {
        pages = await db.reportPages(id);
        pagesFor = builtKey;
      }
      if (rebuild && r.rendered_at !== rebuild.at) {
        rebuild = null;
        toast.success("Rebuilt. The preview and PDF are up to date.");
      } else if (rebuild && r.render_error && r.render_error !== rebuild.err) {
        rebuild = null;
        toast.error(`The PDF couldn't be rebuilt: ${r.render_error}`);
      }
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (report === undefined) loadError = m;
      else toast.error(`Couldn't refresh this report. ${m}`);
    }
  }

  $effect(() => {
    void id;
    pagesFor = "";
    rebuild = null;
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
  // A rebuild takes about a minute; after 12 with no news, offer the button again.
  const rebuilding = $derived(!!rebuild && now - rebuild.started < 12 * 60_000);
  const dashes = $derived(draft ? dashFields({ report: draft, email: { subject: mail.subject, body: mail.body } }) : []);
  const shown = $derived(draft ? draft.computers.list.filter((c) => !c.hidden).length : 0);
  // Which tabs have unsaved edits (a dot on the tab).
  const baseDraft = $derived(base.content ? (JSON.parse(base.content) as ReportContent) : null);
  const textDirty = $derived(!!draft && !!baseDraft && JSON.stringify({ ...draft, computers: null }) !== JSON.stringify({ ...baseDraft, computers: null }));
  const compsDirty = $derived(!!draft && !!baseDraft && JSON.stringify(draft.computers) !== JSON.stringify(baseDraft.computers));
  const TABS = $derived<{ id: TabId; label: string; dirty: boolean }[]>([
    { id: "text", label: "Report text", dirty: textDirty },
    { id: "computers", label: "Computers", dirty: compsDirty },
    { id: "email", label: "Email", dirty: mailDirty },
    { id: "unifi", label: "UniFi", dirty: false },
    { id: "history", label: "History", dirty: false },
    { id: "advanced", label: "Advanced", dirty: false },
  ]);
  // Arrow keys, Home and End move between tabs (and show them).
  async function tabKey(e: KeyboardEvent, i: number) {
    const n = TABS.length;
    const j = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    pick(TABS[j]!.id);
    await tick();
    document.getElementById(`tab-${TABS[j]!.id}`)?.focus();
  }
  /** What a UniFi device is, in plain words (the same rules as the reports repo). */
  function deviceKind(d: { isConsole: boolean; isApp?: boolean; name: string; model: string }): string {
    if (d.isApp) return "Network app";
    if (d.isConsole) return "Router";
    const s = `${d.name} ${d.model}`;
    if (/access point|\b(U6|U7|UAP|UAL|UWB|AC|nanoHD|FlexHD|BeaconHD)\b|\bU[67][ -]/i.test(s)) return "Wi-Fi access point";
    if (/switch|\b(USW|US-|USL|USM)/i.test(s)) return "Network switch";
    if (/NVR|recorder/i.test(s)) return "Video recorder";
    if (/camera|\bG[3-6]\b|UVC/i.test(s)) return "Camera";
    return "Network device";
  }

  // Leaving with unsaved edits: ask first (moving around the app, and closing the tab).
  guardUnsaved(() => dirty, () => confirm.ask({ title: "Leave without saving?", body: "Your edits to this report haven't been saved.", action: "Leave", danger: true }));
  // A new edit clears what the last Save said.
  $effect(() => {
    if (dirty) saveDone = "";
  });

  async function act(fn: () => Promise<unknown>, ok: string) {
    busy = true;
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(messageOf(e, "That didn't go through. Try again."));
    } finally {
      busy = false;
      await load();
    }
  }

  async function loadUnifi() {
    if (!client) return;
    try {
      unifi = await db.unifiStatus(client.id);
    } catch (e) {
      unifiMsg = e instanceof Error ? `Couldn't load the UniFi status: ${e.message}` : "Couldn't load the UniFi status.";
    }
    unifiLoaded = true;
  }
  /** Check now: start the read only UniFi check for this client and wait for its result (about a minute). */
  async function checkUnifi() {
    if (!client || unifiChecking) return;
    const before = unifi?.checked_at ?? null;
    unifiMsg = "";
    try {
      await db.reportAction(id, "unifi");
    } catch (e) {
      unifiMsg = e instanceof Error ? e.message : "The check didn't start. Try again.";
      return;
    }
    unifiChecking = true;
    unifiMsg = "Checking UniFi. This takes about a minute.";
    for (let i = 0; i < 48 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      await loadUnifi();
      if (unifi && unifi.checked_at !== before) {
        unifiChecking = false;
        unifiMsg = `Checked ${dateTime(unifi.checked_at)}.`;
        return;
      }
    }
    unifiChecking = false;
    if (!gone) unifiMsg = "The check is taking longer than usual. Look again in a few minutes.";
  }

  /** Save can't go ahead: say why in the save bar, open the right tab, and put the cursor in the field. */
  async function bad(tabId: TabId, fieldId: string, message: string) {
    saveError = message;
    pick(tabId);
    await tick();
    document.getElementById(fieldId)?.focus();
  }
  async function save() {
    if (!report || !draft) return;
    saveError = "";
    saveDone = "";
    const patch: ReportPatch = {};
    if (mailDirty) {
      const to = parseEmails(mail.to), cc = parseEmails(mail.cc);
      if (to.invalid.length || cc.invalid.length) return bad("email", to.invalid.length ? "m-to" : "m-cc", `These don't look like email addresses: ${[...to.invalid, ...cc.invalid].join(", ")}`);
      if (!to.emails.length) return bad("email", "m-to", "Add at least one recipient.");
      if (to.emails.length > 10 || cc.emails.length > 10) return bad("email", to.emails.length > 10 ? "m-to" : "m-cc", "Up to 10 recipients and 10 cc.");
      if (!mail.subject.trim()) return bad("email", "m-subject", "The email needs a subject.");
      if (!mail.body.trim()) return bad("email", "m-body", "The email needs a body.");
      Object.assign(patch, { recipients: to.emails, cc: cc.emails, subject: mail.subject.trim(), email_body: mail.body.trim() });
    }
    if (contentDirty) {
      if (draft.extra) {
        // Empty rows are dropped; the section needs a title and at least one titled item.
        draft.extra.items = draft.extra.items.filter((i) => i.title.trim() || i.text.trim());
        if (!draft.extra.title.trim()) return bad("text", "x-title", "The extra section needs a title.");
        if (!draft.extra.items.length) return bad("text", "x-title", "Add at least one item to the extra section, or remove the section.");
        const untitled = draft.extra.items.findIndex((i) => !i.title.trim());
        if (untitled >= 0) return bad("text", `x-${untitled}-t`, `Extra section item ${untitled + 1} needs a title.`);
      }
      if (draft.network) {
        draft.network.items = draft.network.items.filter((i) => i.title.trim() || i.text.trim());
        if (!draft.network.items.length) draft.network = undefined;
        else if (!draft.network.title.trim()) return bad("text", "net-title", "The network section needs a title.");
      }
      const problem = contentProblem(draft);
      if (problem) return (saveError = `The report can't be saved: ${problem}`);
      patch.content = $state.snapshot(draft) as ReportContent;
    }
    busy = true;
    try {
      await db.updateReport(id, patch);
      let done = "Saved.";
      if (patch.content) {
        try {
          const res = await db.reportAction(id, "render");
          if (res.started) done = "Saved. The PDF is rebuilding with your changes; the preview updates in about a minute.";
        } catch (e) {
          toast.error(`Saved, but the preview didn't start updating: ${messageOf(e, "try again")}.`);
        }
      }
      await load(true);
      saveDone = done;
    } catch (e) {
      saveError = messageOf(e, "Couldn't save. Try again.");
    } finally {
      busy = false;
    }
  }

  function discard() {
    saveError = "";
    if (report) takeDrafts(report);
  }

  async function sendNow() {
    if (!report || !settings) return;
    if (dirty) return toast.error("Save or discard your edits before sending.");
    if (await confirm.ask({ title: `Send ${report.client_name} now?`, body: sendNowText(report, settings.mode), action: "Send now" }))
      await act(() => db.reportAction(id, "send_now"), "Sending. It shows Sent in a minute or two.");
  }
  const setStatus = (status: Report["status"], ok: string) => act(() => db.updateReport(id, { status }), ok);
  // The less common actions, behind the More button in the header.
  const moreItems = $derived<MenuItem[]>([
    ...(can?.cancel ? [{ label: "Cancel report", onselect: cancelReport }] : []),
    ...(can?.remove ? [{ label: "Delete report", danger: true, onselect: remove }] : []),
  ]);
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
    const body = report.is_test
      ? "Test reports can be deleted any time."
      : report.status === "sent"
        ? "It was sent, so this removes the record of it and its PDFs for good. It can't be brought back."
        : "It hasn't been sent. A new one is only made by running Generate reports again.";
    if (!(await confirm.ask({ title: "Delete this report for good?", body, action: "Delete", danger: true }))) return;
    try {
      await db.deleteReport(id);
      base = { content: JSON.stringify(draft), ...mail };
      toast.success("Report deleted.");
      location.hash = "#/reports";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete this report."));
    }
  }
  /** Build the PDF and preview again from what's saved, even with no changes. */
  async function rebuildPdf() {
    if (!report) return;
    if (dirty) return toast.error("You have unsaved changes. Save them (that rebuilds the PDF too) or Discard them first.");
    const from = { at: report.rendered_at, err: report.render_error, started: Date.now() };
    now = from.started;
    await act(async () => {
      await db.reportAction(id, "rebuild");
      rebuild = from;
    }, "Rebuilding the PDF. The preview updates in about a minute.");
  }

  async function retryRender() {
    await act(() => db.reportAction(id, "render"), "The preview is updating.");
  }

  async function download(kind: "client" | "internal") {
    if (!report) return;
    try {
      const b64 = await db.reportPdf(id, kind);
      if (!b64) return toast.error("That PDF hasn't been made yet.");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      const stamp = report.period === "weekly" ? report.period_start : report.period_key;
      a.href = url;
      a.download = `${kind === "internal" ? "INTERNAL " : ""}${report.client_name} ${report.period === "weekly" ? "Weekly" : "Monthly"} Patch Report ${stamp}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(messageOf(e, "Couldn't download the PDF."));
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
      toast.success("JSON applied. Press Save to keep it.");
    } catch (e) {
      jsonError = `That isn't valid JSON: ${e instanceof Error ? e.message : ""}`;
    }
  }
  /**
   * Always leave a computer off this client's future reports (or include it
   * again). Saved on the client right away; leaving it off also hides it on
   * this report, which Save then rebuilds.
   */
  async function leaveOff(pc: ReportContent["computers"]["list"][number], on: boolean) {
    if (!client || !report) return;
    const name = pc.name.trim();
    if (!name) return toast.error("Give the computer a name first.");
    try {
      await db.updateClient(client.id, { report_exclude: withName(client.report_exclude ?? [], name, on) });
      client = await db.client(client.id);
      if (on) pc.hidden = true;
      toast.success(on
        ? `${name} will be left off ${report.client_name}'s future reports. It's hidden here too: Save to rebuild this one.`
        : `${name} will be included in ${report.client_name}'s future reports again.`);
    } catch (e) {
      toast.error(messageOf(e, "Couldn't update the list."));
    }
  }

  /** Make this report's What we did list the template's, for every report generated from now on. */
  async function useListForFuture() {
    if (!draft || !settings) return;
    const list = ($state.snapshot(draft.did.items) as ReportContent["did"]["items"]).filter((i) => i.title.trim());
    if (!list.length) return toast.error("Add at least one item first.");
    const ok = await confirm.ask({
      title: "Use this list for future reports?",
      body: `Every report generated from now on, for every client, starts with these ${list.length} items in this order. Reports already made don't change. You can change it again in the report template.`,
      action: "Use for future reports",
    });
    if (!ok) return;
    try {
      await db.saveReportSettings({ template: { ...resolveTemplate(settings.template), did_items: list } });
      settings = await db.reportSettings();
      toast.success("Saved to the report template. New reports will use this list.");
    } catch (e) {
      toast.error(messageOf(e, "Couldn't update the template."));
    }
  }

  /** Add the optional one-off section and put the cursor in its first item. */
  async function addExtra() {
    if (!draft) return;
    draft.extra = { title: draft.period === "weekly" ? "Extra work this week" : "Extra work this month", items: [{ title: "", text: "" }] };
    await tick();
    document.getElementById("x-0-t")?.focus();
  }
  async function removeNetwork() {
    if (!draft) return;
    draft.network = undefined;
    await tick();
    document.getElementById("tab-text")?.focus();
  }
  async function removeExtra() {
    if (!draft) return;
    draft.extra = undefined;
    await tick();
    document.getElementById("x-add")?.focus();
  }

  const move = <T,>(list: T[], i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
  };
  const pretty = (path: string) => path.replace(/^report\./, "").replace(/^email\.body$/, "email body").replace(/^email\.subject$/, "email subject");
</script>

<a class="back" href="#/reports"><Icon name="arrow-left" size={14} /> All reports</a>

{#if report === undefined}
  <LoadState error={loadError} what="this report" onretry={() => { loadError = ""; load(true); }} />
{:else if report === null || !draft || !st || !can}
  <p class="empty">This report doesn't exist or was deleted.</p>
{:else}
  <header class="head">
    <div class="title">
      <p class="eyebrow">{periodLabel(report)} · {report.period_key} · generated {dateTime(report.created_at)}</p>
      <h1 use:pageHeading>{report.client_name}</h1>
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
      {#if moreItems.length}<Menu label="More actions for this report" items={moreItems} />{/if}
    </div>
  </header>

  {#if report.warnings.length}
    <div class="callout warn" role="note"><strong>Check before sending</strong>{#each report.warnings as w (w)}<p>{w}</p>{/each}</div>
  {/if}
  {#if report.status === "sent"}
    <div class="callout" role="note"><strong>This is what went out.</strong> <p>Sent {report.sent_at ? dateTime(report.sent_at) : ""} to {report.recipients.join(", ")}{report.cc.length ? `, cc ${report.cc.join(", ")}` : ""}. Sent reports can't be changed.</p></div>
  {:else if report.status === "sending"}
    <div class="callout warn" role="note"><strong>Sending.</strong> <p>It can't be edited while it goes out. If it doesn't finish, look in Sent Items of reports@cyberx.la for the subject below, then Mark as sent or Mark as not sent.</p></div>
  {/if}
  {#if report.cleared_at}
    <div class="callout" role="note"><strong>Archived</strong> <p>It's kept; it just doesn't show in the Reports list. <button class="linkbtn" disabled={busy} onclick={() => act(() => db.clearReports([id], false), "Restored. It's back on the Reports list.")}>Restore it</button></p></div>
  {/if}
  {#if changedElsewhere}
    <div class="callout warn" role="alert"><strong>This report changed somewhere else</strong> <p>Saving now replaces that change with yours. <button class="linkbtn" onclick={() => report && takeDrafts(report)}>Load the latest instead</button></p></div>
  {/if}
  {#if dashes.length}
    <div class="callout warn" role="note"><strong>Dashes found</strong> <p>House rule: no dashes as punctuation. Check {dashes.map(pretty).join(", ")}.</p></div>
  {/if}

  <div class="cols">
    <div class="main">
      <div class="tabs" role="tablist" aria-label="Report sections">
        {#each TABS as t, i (t.id)}
          <button type="button" role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel-{t.id}" tabindex={tab === t.id ? 0 : -1} onclick={() => pick(t.id)} onkeydown={(e) => tabKey(e, i)}>
            {t.label}{#if t.dirty}<span class="dot" aria-hidden="true"></span><span class="sr-only"> (unsaved changes)</span>{/if}
          </button>
        {/each}
      </div>

      <div role="tabpanel" id="panel-text" aria-labelledby="tab-text" class="panel" hidden={tab !== "text"}>
        <fieldset class="plain" disabled={locked || busy}>
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
              <div class="card-head">
                <h2>What we did</h2>
                <div class="headbtns">
                  <button type="button" class="btn sm ghost" onclick={useListForFuture}>Use this list for future reports</button>
                  <button type="button" class="btn sm" onclick={() => draft!.did.items.push({ title: "", text: "" })}>Add item</button>
                </div>
              </div>
              <div class="field"><label for="d-title">Section title</label><input id="d-title" class="input" bind:value={draft.did.title} /></div>
              <DidItems bind:items={draft.did.items} />
            </section>

            <section class="card">
              {#if draft.extra}
                <div class="card-head">
                  <h2>Extra section</h2>
                  <div class="headbtns">
                    <button type="button" class="btn sm ghost" onclick={removeExtra}>Remove section</button>
                    <button type="button" class="btn sm" onclick={() => draft!.extra!.items.push({ title: "", text: "" })}>Add item</button>
                  </div>
                </div>
                <p class="hint">Only on this report. Prints at the top of page 2 as section 03; the sections after it move down one.</p>
                <div class="field"><label for="x-title">Section title</label><input id="x-title" class="input" bind:value={draft.extra.title} /></div>
                <DidItems bind:items={draft.extra.items} idPrefix="x" />
              {:else}
                <div class="card-head"><h2>Extra section</h2></div>
                <p class="hint">For one-off work on this report only, like a router replaced or a new computer set up. It prints at the top of page 2.</p>
                <div><button type="button" id="x-add" class="btn sm" onclick={addExtra}>Add an extra section</button></div>
              {/if}
            </section>

            {#if draft.network}
              <section class="card">
                <div class="card-head">
                  <h2>Network updates</h2>
                  <div class="headbtns">
                    <button type="button" class="btn sm ghost" onclick={removeNetwork}>Remove section</button>
                    <button type="button" class="btn sm" onclick={() => draft!.network!.items.push({ title: "", text: "" })}>Add item</button>
                  </div>
                </div>
                <p class="hint">From UniFi: the devices updated in this report's period. Prints after Updates installed, as a dark card.</p>
                <div class="field"><label for="net-title">Section title</label><input id="net-title" class="input" bind:value={draft.network.title} /></div>
                <DidItems bind:items={draft.network.items} idPrefix="net" />
              </section>
            {/if}

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

        </fieldset>
      </div>

      <div role="tabpanel" id="panel-computers" aria-labelledby="tab-computers" class="panel" hidden={tab !== "computers"}>
        <fieldset class="plain" disabled={locked || busy}>
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
                      <summary><strong>{pc.name || "Unnamed"}</strong> <span class="muted">{pc.run} · {pc.status}{pc.hidden ? " · hidden" : ""}{isLeftOff(client?.report_exclude, pc.name) ? " · always left off" : ""} · {pc.updates.count} {pc.updates.count === 1 ? "update" : "updates"}</span></summary>
                      <div class="pc">
                        <div class="grid">
                          <div class="field"><label for="pc-{i}-n">Name</label><input id="pc-{i}-n" class="input" bind:value={pc.name} /></div>
                          <div class="field"><label for="pc-{i}-h">Computer name</label><input id="pc-{i}-h" class="input" bind:value={pc.host} aria-describedby="pc-{i}-h-hint" /><span id="pc-{i}-h-hint" class="hint">Shown smaller after the name. Leave blank to hide it.</span></div>
                          <div class="field"><label for="pc-{i}-r">{draft.computers.columns[1]?.label ?? "Run"}</label><input id="pc-{i}-r" class="input" bind:value={pc.run} /></div>
                          <div class="field"><label for="pc-{i}-q">{draft.computers.columns[2]?.label ?? "Updates queued"}</label><input id="pc-{i}-q" class="input" bind:value={pc.pending} /></div>
                          <div class="field"><label for="pc-{i}-c">{draft.computers.columns[3]?.label ?? "Critical risks"}</label><input id="pc-{i}-c" class="input" bind:value={pc.crit} /></div>
                          <div class="field"><label for="pc-{i}-s">{draft.computers.columns[4]?.label ?? "Status"}</label><input id="pc-{i}-s" class="input" bind:value={pc.status} /></div>
                          <div class="field"><label for="pc-{i}-t">Status color</label><select id="pc-{i}-t" class="input" bind:value={pc.tone}>{#each TONES as t (t)}<option value={t}>{TONE_LABEL[t]}</option>{/each}</select></div>
                        </div>
                        <label class="check"><input type="checkbox" bind:checked={pc.hidden} /> Hide this computer from this report</label>
                        <div class="leaveoff">
                          {#if isLeftOff(client?.report_exclude, pc.name)}
                            <p class="hint">Always left off {report.client_name}'s future reports.</p>
                            <button type="button" class="btn sm" onclick={() => leaveOff(pc, false)}>Include in future reports<span class="sr-only"> {pc.name}</span></button>
                          {:else}
                            <p class="hint">Hiding or deleting only changes this report. To skip this computer every week:</p>
                            <button type="button" class="btn sm" onclick={() => leaveOff(pc, true)}>Leave off future reports<span class="sr-only"> {pc.name}</span></button>
                          {/if}
                        </div>
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
                          <button type="button" class="btn sm ghost danger" onclick={() => draft!.computers.list.splice(i, 1)}>Delete computer<span class="sr-only"> {pc.name}</span></button>
                        </div>
                      </div>
                    </details>
                  </li>
                {/each}
              </ul>
            </section>

        </fieldset>
      </div>

      <div role="tabpanel" id="panel-email" aria-labelledby="tab-email" class="panel" hidden={tab !== "email"}>
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

        </fieldset>
      </div>

      <div role="tabpanel" id="panel-unifi" aria-labelledby="tab-unifi" class="panel" hidden={tab !== "unifi"}>
        <section class="card">
          <div class="card-head"><h2>UniFi</h2>{#if unifi}<span class="sub">Last checked {dateTime(unifi.checked_at)}</span>{/if}</div>
          {#if !client?.unifi_console}
            <p class="muted">No UniFi console is set for {report.client_name}. Add it on <a href="#/clients/{report.client_id}">{report.client_name}'s page</a>, in the Reports card.</p>
          {:else}
            {#if !unifiLoaded}
              <p class="muted">Loading…</p>
            {:else if !unifi}
              <p class="muted">Not checked yet. Press Check now.</p>
            {:else if unifi.data.error}
              <p class="error">UniFi couldn't be read: {unifi.data.error}</p>
            {:else if !unifi.data.found}
              <p class="error">UniFi has no console named "{client.unifi_console}". Check the name on <a href="#/clients/{report.client_id}">{report.client_name}'s page</a>.</p>
            {:else if !unifi.data.devices.length}
              <p class="muted">UniFi lists no devices on this console.</p>
            {:else}
              <p class="hint">{unifi.data.console}: {unifi.data.devices.length} {unifi.data.devices.length === 1 ? "device" : "devices"}, the router first.</p>
              <ul class="devcards">
                {#each [...unifi.data.devices].sort((a, b) => Number(b.isConsole) - Number(a.isConsole) || Number(!!b.isApp) - Number(!!a.isApp)) as d, i (i)}
                  <li class="devcard" class:router={d.isConsole}>
                    <div class="devhead">
                      <div>
                        <p class="kind">{deviceKind(d)}</p>
                        <h3>{d.name}{#if !d.isApp} <span class="muted">{d.model}</span>{/if}</h3>
                      </div>
                      {#if d.needsUpdate}<ReportPill label={d.updateAvailable ? `Update waiting: ${d.updateAvailable}` : "Update waiting"} tone="warn" />{:else if !d.online}<ReportPill label="Offline" tone="bad" />{:else}<ReportPill label="Up to date" tone="good" />{/if}
                    </div>
                    <dl class="facts">
                      <div><dt>Software version</dt><dd>{d.version || "Unknown"}</dd></div>
                      <div>
                        <dt>Last update</dt>
                        <dd>
                          {#if d.lastUpdate}{dateTime(d.lastUpdate.at)} <span class="muted">({d.lastUpdate.from} to {d.lastUpdate.to})</span>
                          {:else}None seen yet{d.trackedSince ? ` (checks began ${shortDate(d.trackedSince)})` : ""}{/if}
                        </dd>
                      </div>
                      {#if !d.isApp}<div><dt>Last restart</dt><dd>{d.startupTime ? dateTime(d.startupTime) : "Unknown"}</dd></div>{/if}
                      <div><dt>Status</dt><dd>{d.isApp ? (d.online ? "Running" : "Stopped") : d.online ? "Online" : d.status || "Offline"}</dd></div>
                    </dl>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="checknow">
              <button type="button" class="btn sm" disabled={unifiChecking} onclick={checkUnifi}>{unifiChecking ? "Checking…" : "Check now"}</button>
              <span class="hint" role="status">{unifiMsg}</span>
            </div>
            <p class="hint">Reads the router, its Network app and every access point through UniFi; it changes nothing. They are also checked every morning and when the Sunday reports are made.</p>
          {/if}
        </section>
      </div>

      <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" class="panel" hidden={tab !== "history"}>
        <ActivityCard title="History" activity={history} describe={describeReport} empty="Nothing yet." note={(a) => (a.actor_role === "report_writer" ? " · automatic" : "")} />
      </div>

      <div role="tabpanel" id="panel-advanced" aria-labelledby="tab-advanced" class="panel" hidden={tab !== "advanced"}>
        <fieldset class="plain" disabled={locked || busy}>
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
      </div>

    </div>

    <aside class="side">
      <section class="card preview">
        <div class="card-head">
          <h2>Preview</h2>
          <span class="sub" role="status">
            {#if report.render_error && rendering}Preview failed{:else if rendering}Rebuilding the PDF with your changes, about a minute{:else if rebuilding}Rebuilding the PDF, about a minute{:else if pages.length}Up to date{report.rendered_at ? `, built ${dateTime(report.rendered_at)}` : ""}{/if}
          </span>
        </div>
        {#if report.render_error && rendering}
          <p class="error">The PDF couldn't be built: {report.render_error}</p>
          <button class="btn sm" disabled={busy} onclick={retryRender}>Try again</button>
        {/if}
        {#if !locked}
          <div class="rebuild">
            <button class="btn sm" disabled={busy || rebuilding || rendering} onclick={rebuildPdf}>{rebuilding || rendering ? "Rebuilding…" : "Rebuild PDF"}</button>
            <span class="hint">Builds the PDF and preview again from this report as saved.</span>
          </div>
        {/if}
        {#if pages.length}
          <div class="pages" class:stale={rendering || rebuilding} role="region" aria-label="Preview pages">
            {#each pages as p, i (p.page)}
              <button type="button" class="pagebtn" onclick={(e) => lightbox?.open(i, e.currentTarget)}>
                <img src={p.src} alt="Page {p.page} of {pages.length} of the client PDF" loading="lazy" width="935" height="1210" />
                <span class="sr-only">, open larger</span>
              </button>
            {/each}
          </div>
          <p class="hint">Click a page to see it larger.</p>
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

  {#if !locked}
    <!-- Always on screen while the report can be edited, so Save is easy to find. -->
    <SaveBar {dirty} {busy} error={saveError} done={saveDone} onsave={save} ondiscard={discard}
      label={contentDirty ? "Save and rebuild PDF" : "Save"}
      hint={`Unsaved changes${contentDirty ? ". Saving rebuilds the PDF (about a minute)." : ""}`} />
  {/if}
{/if}

<Confirm bind:this={confirm} />
{#if report}<PageLightbox bind:this={lightbox} {pages} title={`${report.client_name}, ${report.period === "weekly" ? "weekly" : "monthly"} report`} />{/if}

<style>
  .back { display: inline-block; font-size: var(--fs-sm); color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .title { min-width: 0; }
  h1 { font-size: var(--fs-2xl); letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 10px; overflow-wrap: anywhere; }
  .state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: var(--fs-md); }
  .state .muted { color: var(--text-2); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); gap: 16px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  /* Tabs: one row that scrolls sideways on a phone rather than wrapping. */
  .tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); overflow-x: auto; scrollbar-width: thin; }
  .tabs [role="tab"] {
    position: relative; flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: 0; border-radius: var(--radius-sm);
    background: none; color: var(--text-2); font: inherit; font-size: var(--fs-md); font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .tabs [role="tab"]:hover { color: var(--text); background: var(--surface-2); }
  .tabs [role="tab"][aria-selected="true"] { color: var(--ink); background: var(--lime); }
  .tabs .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warning); }
  .tabs [aria-selected="true"] .dot { background: var(--ink); }
  .panel { min-width: 0; }
  .panel[hidden] { display: none; }
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; }
  .facts div { min-width: 0; }
  .facts dt { font-size: var(--fs-xs); color: var(--muted); margin-bottom: 2px; }
  .facts dd { font-size: var(--fs-base); overflow-wrap: anywhere; }
  .devcards { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .devcard { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .devcard.router { border-color: var(--line-2); background: var(--surface-2); }
  .devhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px 12px; flex-wrap: wrap; }
  .devhead h3 { font-size: var(--fs-base); font-weight: 650; overflow-wrap: anywhere; }
  .devhead h3 .muted { font-size: var(--fs-sm); font-weight: 500; margin-left: 4px; }
  .kind { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); margin-bottom: 2px; }
  .checknow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; border-top: 1px solid var(--line); padding-top: 12px; }
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
  .mono { font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.5; }
  .hint { font-size: var(--fs-xs); color: var(--muted); }
  .hint.top { margin-top: -4px; }
  .row3 { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; gap: 12px; align-items: end; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-2); min-height: 42px; }
  .item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 12px; align-items: end; }
  fieldset.cols5 { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  fieldset legend { font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .pcs { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .pcs li { border: 1px solid var(--line); border-radius: var(--radius-md); }
  .pcs li.hiddenpc summary strong { text-decoration: line-through; color: var(--muted); }
  summary { cursor: pointer; padding: 12px 14px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
  summary .muted { font-size: var(--fs-sm); }
  .pc { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 12px; }
  fieldset.updates { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .upd { display: grid; grid-template-columns: minmax(0, 1fr) 80px 150px auto; gap: 10px; align-items: end; }
  .pcacts { display: flex; flex-wrap: wrap; gap: 6px; }
  .inline { display: inline; font-size: var(--fs-base); font-weight: 600; }
  details > summary h2 { margin: 0; }
  .rowbtns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .reset { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; flex-wrap: wrap; }
  .preview .sub { font-size: 13px; color: var(--text-2); }
  .pages { display: flex; flex-direction: column; gap: 10px; transition: opacity 0.3s; }
  .pages.stale { opacity: 0.55; }
  .rebuild { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 12px; }
  /* position: relative keeps the hidden "open larger" text inside the scrolling strip on phones. */
  .pagebtn { position: relative; display: block; padding: 0; border: 0; background: none; border-radius: var(--radius-sm); cursor: zoom-in; transition: transform 0.2s var(--ease); }
  .pagebtn:hover { transform: translateY(-2px); }
  .pages img { display: block; width: 100%; height: auto; border-radius: var(--radius-sm); background: #fff; box-shadow: var(--shadow-sm); }
  .dl { display: flex; gap: 8px; flex-wrap: wrap; }
  .headbtns { display: flex; flex-wrap: wrap; gap: 8px; }
  .leaveoff { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  @media (max-width: 1100px) {
    .cols { grid-template-columns: 1fr; }
    .side { position: static; order: -1; }
    .pages { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; }
    .pagebtn { flex: none; scroll-snap-align: start; }
    .pages img { width: min(340px, 80vw); }
  }
  @media (max-width: 640px) {
    h1 { font-size: var(--fs-xl); }
    .grid, .row3, .item, .upd, .facts { grid-template-columns: 1fr; }
    fieldset.cols5 { grid-template-columns: 1fr 1fr; }
    .check { min-height: 0; }
  }
</style>
