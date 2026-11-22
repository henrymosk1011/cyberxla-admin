<script lang="ts">
  import db from "$db";
  import Icon from "../components/Icon.svelte";
  import Confirm from "../components/Confirm.svelte";
  import Menu from "../components/Menu.svelte";
  import Modal from "../components/Modal.svelte";
  import Field from "../components/Field.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import GradePill from "../components/GradePill.svelte";
  import ActivityCard from "../components/ActivityCard.svelte";
  import LoadState from "../components/LoadState.svelte";
  import { guardUnsaved } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { ago, dateTime, localDay, phone, shortDate, STATUS_LABEL } from "../lib/format.ts";
  import { PROSPECT_STATUSES, AUTH_METHODS, type AuditAuthorization, type AuditEntry, type AuditRow, type AuthMethod, type AuthorizationInput, type Prospect, type ProspectNote } from "../lib/types.ts";

  let { id, version, onchanged }: { id: string; version: number; onchanged?: () => void } = $props();

  let prospect = $state<Prospect | null | undefined>(undefined);
  let audits = $state<AuditRow[]>([]);
  let auths = $state<AuditAuthorization[]>([]);
  let notes = $state<ProspectNote[]>([]);
  let activity = $state<AuditEntry[]>([]);
  let loadError = $state("");
  let draft = $state("");
  let saving = $state(false);
  let busy = $state(false);
  let confirm: Confirm;

  const AUTH_METHOD_LABEL: Record<AuthMethod, string> = { signed_doc: "Signed document", contract: "Contract", email: "Email confirmation", verbal_recorded: "Recorded verbal" };

  const liveAuth = $derived(auths.find((a) => !a.revoked_at && a.signed_on <= localDay() && a.expires_on >= localDay()
    && prospect?.domain != null && (prospect.domain === a.domain || prospect.domain.endsWith("." + a.domain))));
  const latest = $derived(audits[0] ?? null);

  async function load() {
    try {
      const [p, a, au, n, act] = await Promise.all([db.prospect(id), db.auditsFor(id), db.authorizations(id), db.prospectNotes(id), db.prospectActivity(id)]);
      prospect = p; audits = a; auths = au; notes = n; activity = act;
      loadError = "";
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (prospect === undefined) loadError = m; else toast.error(`Couldn't refresh this prospect. ${m}`);
    }
  }
  $effect(() => { void id; void version; load(); });

  guardUnsaved(() => !!draft.trim(), () => confirm.ask({ title: "Leave without adding the note?", body: "The note you typed hasn't been added.", action: "Leave", danger: true }));

  async function run(fn: () => Promise<void>, failMsg: string) {
    busy = true;
    try { await fn(); } catch (e) { toast.error(messageOf(e, failMsg)); }
    busy = false;
    onchanged?.();
    await load();
  }

  async function runAudit(kind: "passive" | "active") {
    if (busy) return;
    busy = true;
    try {
      const auditId = await db.startAudit(id, kind, false);
      try {
        await db.auditAction(auditId, "scan");
        toast.success(`${kind === "active" ? "Active" : "Passive"} audit started.`);
      } catch {
        toast.info("Audit queued", "It will run once the scanner is connected.");
      }
      onchanged?.();
      await load();
      location.hash = `#/audits/${auditId}`;
    } catch (e) {
      toast.error(messageOf(e, "Couldn't start the audit."));
    } finally {
      busy = false;
    }
  }

  async function setStatus(status: Prospect["status"]) {
    if (!prospect || prospect.status === status) return;
    await run(() => db.updateProspect(id, { status }), "Couldn't change the status.");
  }
  async function convert() {
    if (!prospect) return;
    if (!(await confirm.ask({ title: `Convert ${prospect.business_name} to a lead?`, body: "Creates a sales lead with this business's contact details. The prospect is marked Converted and linked to the lead.", action: "Convert to lead" }))) return;
    busy = true;
    try {
      const leadId = await db.convertProspect(id);
      onchanged?.();
      location.hash = `#/leads/${leadId}`;
    } catch (e) {
      toast.error(messageOf(e, "Couldn't convert this prospect."));
    } finally { busy = false; }
  }
  async function toggleArchive() {
    if (!prospect) return;
    const archiving = !prospect.archived_at;
    if (archiving && !(await confirm.ask({ title: "Archive this prospect?", body: "It leaves your list but nothing is deleted. You can restore it from Prospects → Archived.", action: "Archive" }))) return;
    await run(() => db.archiveProspect(id, archiving), "Couldn't update the prospect.");
  }
  async function del() {
    if (!prospect) return;
    if (!(await confirm.ask({ title: `Delete ${prospect.business_name}?`, body: "Permanently deletes the prospect, its audits, authorizations and notes. A prospect with a sent audit can't be deleted (archive it instead). This can't be undone.", action: "Delete permanently", danger: true }))) return;
    try {
      await db.deleteProspect(id);
      toast.success(`${prospect.business_name} was deleted.`);
      onchanged?.();
      location.hash = "#/prospects";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete the prospect."));
    }
  }
  async function addNote(e: SubmitEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    saving = true;
    try { await db.addProspectNote(id, body); draft = ""; await load(); }
    catch (err) { toast.error(messageOf(err, "Couldn't save the note.")); }
    finally { saving = false; }
  }
  async function deleteNote(n: ProspectNote) {
    const preview = n.body.length > 80 ? n.body.slice(0, 80) + "…" : n.body;
    if (!(await confirm.ask({ title: "Delete this note?", body: `"${preview}" will be permanently deleted.`, action: "Delete", danger: true }))) return;
    await run(() => db.deleteProspectNote(n.id), "Couldn't delete the note.");
  }

  // --- Edit details ---
  let editing = $state(false);
  const blankEdit = () => ({ business_name: "", website: "", email: "", contact_name: "", phone: "", city: "", region: "", industry: "" });
  let eForm = $state(blankEdit());
  function openEdit() {
    if (!prospect) return;
    eForm = { business_name: prospect.business_name, website: prospect.website ?? "", email: prospect.email ?? "", contact_name: prospect.contact_name ?? "", phone: prospect.phone ?? "", city: prospect.city ?? "", region: prospect.region ?? "", industry: prospect.industry ?? "" };
    editing = true;
  }
  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!eForm.business_name.trim()) return;
    saving = true;
    try {
      await db.updateProspect(id, {
        business_name: eForm.business_name.trim(), website: eForm.website.trim() || null,
        email: eForm.email.trim() || null, contact_name: eForm.contact_name.trim() || null, phone: eForm.phone.trim() || null,
        city: eForm.city.trim() || null, region: eForm.region.trim() || null, industry: eForm.industry.trim() || null,
      });
      editing = false; await load();
    } catch (err) { toast.error(messageOf(err, "Couldn't save the changes.")); }
    finally { saving = false; }
  }

  // --- Authorizations ---
  let authoring = $state(false);
  const blankAuth = () => ({ domain: prospect?.domain ?? "", scope: "External active testing of the public web presence", method: "signed_doc" as AuthMethod, authorized_by_name: "", authorized_by_title: "", authorized_by_email: "", evidence: "", signed_on: localDay(), expires_on: localDay(90) });
  let aForm = $state(blankAuth());
  function openAuth() { aForm = blankAuth(); authoring = true; }
  async function saveAuth(e: SubmitEvent) {
    e.preventDefault();
    if (!aForm.domain.trim() || !aForm.authorized_by_name.trim() || !aForm.authorized_by_email.trim()) return;
    saving = true;
    try {
      const input: AuthorizationInput = {
        prospect_id: id, domain: aForm.domain.trim().toLowerCase(), scope: aForm.scope.trim(), method: aForm.method,
        authorized_by_name: aForm.authorized_by_name.trim(), authorized_by_title: aForm.authorized_by_title.trim() || null,
        authorized_by_email: aForm.authorized_by_email.trim(), evidence: aForm.evidence.trim() || null,
        signed_on: aForm.signed_on, expires_on: aForm.expires_on,
      };
      await db.addAuthorization(input);
      authoring = false; await load();
      toast.success("Authorization recorded. Active audits of this domain are now unlocked.");
    } catch (err) { toast.error(messageOf(err, "Couldn't save the authorization.")); }
    finally { saving = false; }
  }
  async function revokeAuth(a: AuditAuthorization) {
    const revoking = !a.revoked_at;
    if (revoking && !(await confirm.ask({ title: "Revoke this authorization?", body: "Active audits of this domain will be blocked again. Audits already run are kept.", action: "Revoke", danger: true }))) return;
    await run(() => db.setAuthorizationRevoked(a.id, revoking), "Couldn't update the authorization.");
  }
  const authLive = (a: AuditAuthorization) => !a.revoked_at && a.signed_on <= localDay() && a.expires_on >= localDay();

  function describe(a: AuditEntry): string {
    const n = a.new_data ?? {}, o = a.old_data ?? {};
    const who = a.actor_role === "authenticated" ? "You" : a.actor_role === "audit_runner" ? "Scanner" : "System";
    if (a.table_name === "prospects") {
      if (a.action === "insert") return `${who}: prospect added`;
      if ((n.archived_at ?? null) !== (o.archived_at ?? null)) return `${who}: prospect ${n.archived_at ? "archived" : "restored"}`;
      if (n.status !== o.status) return `${who}: status ${STATUS_LABEL[String(o.status)] ?? o.status} → ${STATUS_LABEL[String(n.status)] ?? n.status}`;
      return `${who}: details updated`;
    }
    if (a.table_name === "audits") {
      if (a.action === "insert") return `${who}: ${n.kind === "active" ? "active" : "passive"} audit queued`;
      if (n.scan_status !== o.scan_status) return `${who}: scan ${STATUS_LABEL[String(n.scan_status)]?.toLowerCase() ?? n.scan_status}`;
      if (n.delivery !== o.delivery) return `${who}: report ${String(n.delivery)}`;
      return `${who}: audit updated`;
    }
    if (a.table_name === "audit_authorizations") return a.action === "insert" ? `${who}: authorization recorded` : a.action === "delete" ? `${who}: authorization deleted` : `${who}: authorization updated`;
    return `${who}: ${a.action}`;
  }
  const tel = (p: string) => "tel:" + p.replace(/[^0-9+]/g, "");
  const auditHref = (aid: string) => `#/audits/${aid}`;
</script>

<a class="back" href="#/prospects"><Icon name="arrow-left" size={14} /> All prospects</a>

{#if prospect === undefined}
  <LoadState error={loadError} what="this prospect" onretry={() => { loadError = ""; load(); }} />
{:else if prospect === null}
  <p class="empty">This prospect doesn't exist or was deleted.</p>
{:else}
  {@const p = prospect}
  <PageHeader eyebrow={`Prospect · ${STATUS_LABEL[p.source] ?? p.source} · since ${shortDate(p.created_at)}`} title={p.business_name}>
    {#snippet meta()}
      <p class="contact">
        {#if p.website}<a href={p.website} target="_blank" rel="noopener noreferrer">{p.domain ?? p.website}</a>{/if}
        {#if p.email}<a href="mailto:{p.email}">{p.email}</a>{/if}
        {#if p.phone}<a href={tel(p.phone)}>{phone(p.phone)}</a>{/if}
        {#if p.city || p.industry}<span>{[p.city, p.industry].filter(Boolean).join(" · ")}</span>{/if}
      </p>
    {/snippet}
    <div class="headacts">
      <button class="btn primary sm" disabled={busy || !p.website} title={p.website ? "Run a passive external posture audit" : "Add a website first"} onclick={() => runAudit("passive")}>Run passive audit</button>
      <button class="btn sm" disabled={busy || !liveAuth} title={liveAuth ? "Run an authorized active audit" : "Record a signed authorization first"} onclick={() => runAudit("active")}>Run active audit</button>
      {#if p.lead_id}<a class="btn sm" href="#/leads/{p.lead_id}">View lead <Icon name="arrow-right" size={14} /></a>
      {:else}<button class="btn sm" disabled={busy} onclick={convert}>Convert to lead</button>{/if}
      <Menu label="More actions for this prospect" items={[
        { label: "Edit details", onselect: openEdit },
        { label: p.archived_at ? "Restore prospect" : "Archive prospect", onselect: toggleArchive },
        { label: "Delete prospect", danger: true, onselect: del },
      ]} />
    </div>
  </PageHeader>

  {#if p.archived_at}<p class="banner">This prospect is archived ({shortDate(p.archived_at)}). It's off your list but kept.</p>{/if}

  <div class="statusrow">
    <label for="p-status" class="muted small">Status</label>
    <select id="p-status" class="input sel" value={p.status} onchange={(e) => setStatus(e.currentTarget.value as Prospect["status"])}>
      {#each PROSPECT_STATUSES as st (st)}<option value={st}>{STATUS_LABEL[st]}</option>{/each}
    </select>
  </div>

  <div class="cols">
    <div class="main">
      <!-- Audits -->
      <section class="card">
        <div class="card-head">
          <h2>Audits</h2>
          {#if latest && latest.scan_status === "done"}<a class="btn ghost sm" href={auditHref(latest.id)}>Open latest</a>{/if}
        </div>
        {#if latest && latest.scan_status === "done"}
          <a class="latest" href={auditHref(latest.id)}>
            <GradePill grade={latest.grade} score={latest.score} size="lg" />
            <div class="latest-txt">
              <strong>{latest.summary ?? "Audit complete."}</strong>
              <span class="muted small">{latest.kind === "active" ? "Active" : "Passive"} audit · {dateTime(latest.created_at)}{#if latest.delivery === "sent"} · report sent{/if}</span>
            </div>
            <Icon name="arrow-right" size={16} />
          </a>
        {/if}
        {#if audits.length}
          <ul class="auditlist">
            {#each audits as a (a.id)}
              <li>
                <a href={auditHref(a.id)} class="arow">
                  <span class="arow-main">
                    {#if a.scan_status === "done"}<GradePill grade={a.grade} score={a.score} size="sm" />
                    {:else}<StatusPill status={a.scan_status} />{/if}
                    <span class="arow-txt">
                      <span>{a.kind === "active" ? "Active" : "Passive"} audit</span>
                      <span class="muted small">{dateTime(a.created_at)}{#if a.is_test} · test{/if}</span>
                    </span>
                  </span>
                  <span class="arow-side">
                    {#if a.delivery === "sent"}<span class="sent small">Sent</span>{:else if a.delivery === "sending"}<span class="muted small">Sending…</span>{/if}
                    {#if a.scan_status === "failed"}<span class="small bad">Failed</span>{/if}
                    <Icon name="arrow-right" size={14} />
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No audits yet. {p.website ? "Run a passive audit to get a grade and findings." : "Add a website first, then run an audit."}</p>
        {/if}
      </section>

      <!-- Authorizations -->
      <section class="card">
        <div class="card-head">
          <h2>Active-audit authorization</h2>
          <button class="btn sm" onclick={openAuth}>Record authorization</button>
        </div>
        <p class="muted cardintro">Passive audits only read what's public and need no permission. An <strong>active</strong> audit (intrusive probing) is blocked until a current signed authorization for this domain is on file.</p>
        {#if auths.length}
          <ul class="authlist">
            {#each auths as a (a.id)}
              <li class:dead={!authLive(a)}>
                <div class="auth-main">
                  <strong>{a.authorized_by_name}{#if a.authorized_by_title}<span class="muted">, {a.authorized_by_title}</span>{/if}</strong>
                  <span class="muted small">{a.domain} · {AUTH_METHOD_LABEL[a.method]} · {shortDate(a.signed_on)} to {shortDate(a.expires_on)}</span>
                  {#if a.scope}<span class="small scope">{a.scope}</span>{/if}
                </div>
                <div class="auth-side">
                  {#if a.revoked_at}<span class="small bad">Revoked</span>
                  {:else if authLive(a)}<span class="small ok">Live</span>
                  {:else}<span class="small muted">Expired</span>{/if}
                  <button class="btn ghost sm" onclick={() => revokeAuth(a)}>{a.revoked_at ? "Reinstate" : "Revoke"}</button>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No authorization on file. Active audits of this domain are blocked.</p>
        {/if}
      </section>
    </div>

    <aside class="side">
      <section class="card">
        <div class="card-head"><h2>Notes</h2></div>
        <form class="noteform" onsubmit={addNote}>
          <textarea class="input" placeholder="Outreach notes, replies, next steps…" maxlength="10000" aria-label="New note" bind:value={draft}></textarea>
          <button class="btn primary sm" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Add note"}</button>
        </form>
        <ul class="notes">
          {#each notes as n (n.id)}
            <li>
              <div><p>{n.body}</p><span class="muted small">{dateTime(n.created_at)}</span></div>
              <button class="iconbtn danger" title="Delete note" aria-label="Delete this note" onclick={() => deleteNote(n)}><Icon name="close" /></button>
            </li>
          {/each}
        </ul>
      </section>
      <ActivityCard {activity} {describe} />
    </aside>
  </div>
{/if}

<Modal open={editing} title="Edit prospect" onclose={() => (editing = false)}>
  <form class="stack" onsubmit={saveEdit}>
    <Field id="e-name" label="Business name" required><input id="e-name" class="input" bind:value={eForm.business_name} maxlength="200" required /></Field>
    <Field id="e-web" label="Website" hint="We audit this. The domain is read from it."><input id="e-web" class="input" bind:value={eForm.website} placeholder="example.com" maxlength="300" /></Field>
    <div class="two">
      <Field id="e-contact" label="Contact name"><input id="e-contact" class="input" bind:value={eForm.contact_name} maxlength="160" /></Field>
      <Field id="e-email" label="Email"><input id="e-email" class="input" type="email" bind:value={eForm.email} maxlength="254" /></Field>
    </div>
    <div class="two">
      <Field id="e-city" label="City"><input id="e-city" class="input" bind:value={eForm.city} maxlength="120" /></Field>
      <Field id="e-industry" label="Industry"><input id="e-industry" class="input" bind:value={eForm.industry} maxlength="120" /></Field>
    </div>
    <Field id="e-phone" label="Phone"><input id="e-phone" class="input" bind:value={eForm.phone} maxlength="40" /></Field>
    <div class="actions"><button type="button" class="btn" onclick={() => (editing = false)}>Cancel</button><button class="btn primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
  </form>
</Modal>

<Modal open={authoring} title="Record active-audit authorization" onclose={() => (authoring = false)}>
  <form class="stack" onsubmit={saveAuth}>
    <p class="muted hint">Only record this when the business has given you written permission to actively test the named domain. It's your paper trail and it unlocks active audits.</p>
    <Field id="a-domain" label="Domain" required hint="Covers this domain and its subdomains"><input id="a-domain" class="input" bind:value={aForm.domain} placeholder="example.com" required /></Field>
    <Field id="a-scope" label="Scope"><input id="a-scope" class="input" bind:value={aForm.scope} maxlength="1000" /></Field>
    <div class="two">
      <Field id="a-name" label="Authorized by" required><input id="a-name" class="input" bind:value={aForm.authorized_by_name} maxlength="160" required /></Field>
      <Field id="a-title" label="Title"><input id="a-title" class="input" bind:value={aForm.authorized_by_title} maxlength="160" /></Field>
    </div>
    <Field id="a-email" label="Their email" required><input id="a-email" class="input" type="email" bind:value={aForm.authorized_by_email} maxlength="254" required /></Field>
    <div class="two">
      <Field id="a-method" label="How"><select id="a-method" class="input" bind:value={aForm.method}>{#each AUTH_METHODS as m (m)}<option value={m}>{AUTH_METHOD_LABEL[m]}</option>{/each}</select></Field>
      <Field id="a-evidence" label="Reference" hint="File name, contract id, email subject"><input id="a-evidence" class="input" bind:value={aForm.evidence} maxlength="2000" /></Field>
    </div>
    <div class="two">
      <Field id="a-signed" label="Signed on" required><input id="a-signed" class="input" type="date" bind:value={aForm.signed_on} required /></Field>
      <Field id="a-expires" label="Expires on" required><input id="a-expires" class="input" type="date" bind:value={aForm.expires_on} required /></Field>
    </div>
    <div class="actions"><button type="button" class="btn" onclick={() => (authoring = false)}>Cancel</button><button class="btn primary" disabled={saving}>{saving ? "Saving…" : "Record authorization"}</button></div>
  </form>
</Modal>

<Confirm bind:this={confirm} />

<style>
  .headacts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .banner { margin-bottom: 16px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--line-2); color: var(--text-2); font-size: var(--fs-md); }
  .statusrow { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .sel { height: var(--control-sm); padding: 0 36px 0 12px; font-size: var(--fs-sm); background-position: right 12px center; max-width: 220px; }
  .cardintro { font-size: var(--fs-sm); margin-top: -2px; margin-bottom: 14px; }
  .latest { display: flex; align-items: center; gap: 14px; padding: 14px; margin-bottom: 14px; border: 1px solid var(--line-2); border-radius: var(--radius-md); background: var(--ink); text-decoration: none; color: inherit; transition: border-color 0.2s; }
  .latest:hover { border-color: var(--lime); }
  .latest-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .latest-txt strong { font-weight: 600; }
  .auditlist, .authlist, .notes { list-style: none; display: flex; flex-direction: column; }
  .arow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 2px; border-top: 1px solid var(--line); text-decoration: none; color: inherit; }
  .arow:hover { background: rgba(255,255,255,0.02); }
  .arow-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .arow-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .arow-side { display: flex; align-items: center; gap: 8px; color: var(--muted); }
  .small { font-size: var(--fs-xs); }
  .bad { color: #ff6b6b; }
  .ok { color: var(--good-text); }
  .sent { color: var(--good-text); font-weight: 600; }
  .authlist li { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--line); }
  .authlist li.dead { opacity: 0.6; }
  .auth-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .scope { color: var(--text-2); }
  .auth-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none; }
  .noteform { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
  .noteform textarea { width: 100%; }
  .notes li { display: flex; gap: 8px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--line); }
  .notes li > div { flex: 1; min-width: 0; }
  .notes p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-md); }
  .notes .iconbtn { opacity: 0; }
  .notes li:hover .iconbtn, .notes .iconbtn:focus-visible { opacity: 1; }
  @media (hover: none) { .notes .iconbtn { opacity: 1; } }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: var(--fs-sm); margin: -2px 0 2px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .side { display: flex; flex-direction: column; gap: 20px; }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .two { grid-template-columns: 1fr; } .headacts { justify-content: flex-start; width: 100%; } }
</style>
