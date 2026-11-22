<script lang="ts">
  import db from "$db";
  import PageHeader from "../components/PageHeader.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import GradePill from "../components/GradePill.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import Field from "../components/Field.svelte";
  import SortSelect from "../components/SortSelect.svelte";
  import SortTh from "../components/SortTh.svelte";
  import { by, pressed, text, type Sort, type SortDir } from "../lib/sort.ts";
  import { ago, STATUS_LABEL } from "../lib/format.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { PROSPECT_STATUSES, OPEN_PROSPECT_STATUSES, type AuditRow, type DiscoverParams, type Prospect, type ProspectInput, type QuickScanResult } from "../lib/types.ts";

  let { prospects, audits, onchanged }: { prospects: Prospect[]; audits: AuditRow[]; onchanged?: () => void } = $props();

  let q = $state("");
  let filter = $state<"open" | "all" | "archived" | Prospect["status"]>("open");
  type Col = "name" | "status" | "grade" | "location" | "audits" | "recent";
  const COLUMNS: { key: Col; label: string; first: SortDir; right?: boolean; hide?: "sm" }[] = [
    { key: "name", label: "Business", first: "asc" },
    { key: "status", label: "Status", first: "asc" },
    { key: "grade", label: "Grade", first: "asc" },
    { key: "location", label: "Location", first: "asc", hide: "sm" },
    { key: "audits", label: "Audits", first: "desc", right: true, hide: "sm" },
    { key: "recent", label: "Last activity", first: "desc", right: true, hide: "sm" },
  ];
  let sort = $state<Sort<Col>>({ key: "recent", dir: "desc" });
  const sortBy = (k: Col) => (sort = pressed(sort, k, COLUMNS.find((c) => c.key === k)!.first));

  // Latest audit per prospect, and a count, for the Grade and Audits columns.
  const latest = $derived.by(() => {
    const m = new Map<string, AuditRow>();
    const n = new Map<string, number>();
    for (const a of [...audits].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
      m.set(a.prospect_id, a); // last wins = newest
      n.set(a.prospect_id, (n.get(a.prospect_id) ?? 0) + 1);
    }
    return { m, n };
  });
  const GRADE_ORDER: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };

  const active = $derived(prospects.filter((p) => !p.archived_at));
  const archivedList = $derived(prospects.filter((p) => p.archived_at));
  function search(list: Prospect[]) {
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((p) => [p.business_name, p.domain ?? "", p.email ?? "", p.city ?? "", p.industry ?? ""].some((v) => v.toLowerCase().includes(s)));
  }
  const searched = $derived(search(active));
  const searchedArchived = $derived(search(archivedList));
  const counts = $derived(Object.fromEntries(PROSPECT_STATUSES.map((st) => [st, searched.filter((p) => p.status === st).length])) as Record<Prospect["status"], number>);

  const rows = $derived.by(() => {
    const base = filter === "archived" ? searchedArchived
      : searched.filter((p) => filter === "all" || (filter === "open" ? OPEN_PROSPECT_STATUSES.includes(p.status) : p.status === filter));
    const cmp: Record<Col, (a: Prospect, b: Prospect) => number> = {
      name: (a, b) => text(a.business_name, b.business_name),
      status: (a, b) => PROSPECT_STATUSES.indexOf(a.status) - PROSPECT_STATUSES.indexOf(b.status),
      grade: (a, b) => (GRADE_ORDER[latest.m.get(a.id)?.grade ?? ""] ?? 9) - (GRADE_ORDER[latest.m.get(b.id)?.grade ?? ""] ?? 9),
      location: (a, b) => text(a.city ?? "", b.city ?? ""),
      audits: (a, b) => (latest.n.get(a.id) ?? 0) - (latest.n.get(b.id) ?? 0),
      recent: (a, b) => a.updated_at.localeCompare(b.updated_at),
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...base].sort(by((a, b) => sign * cmp[sort.key](a, b), (a, b) => b.updated_at.localeCompare(a.updated_at)));
  });

  const openProspect = (id: string) => (location.hash = `#/prospects/${id}`);

  // --- Bulk select + scan now ---
  // Only prospects with a website can be scanned, so only those are selectable.
  let selected = $state(new Set<string>());
  let scanning = $state(false);
  const scannable = $derived(rows.filter((p) => !!p.website));
  const selCount = $derived([...selected].filter((id) => scannable.some((p) => p.id === id)).length);
  const allSelected = $derived(scannable.length > 0 && scannable.every((p) => selected.has(p.id)));
  const someSelected = $derived(scannable.some((p) => selected.has(p.id)));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }
  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) for (const p of scannable) next.delete(p.id);
    else for (const p of scannable) next.add(p.id);
    selected = next;
  }
  const clearSelection = () => (selected = new Set());

  async function scanSelected() {
    const ids = [...selected].filter((id) => scannable.some((p) => p.id === id));
    if (!ids.length || scanning) return;
    scanning = true;
    try {
      const n = await db.scanProspects(ids, true);
      if (n > 0) {
        await db.scanQueue();
        toast.success(`Scanning ${n} ${n === 1 ? "prospect" : "prospects"}. Grades fill in here as each one finishes.`);
      } else {
        toast.info("Already scanning", "The selected prospects each already have a scan in flight.");
      }
      selected = new Set();
      onchanged?.();
    } catch (e) {
      toast.error(messageOf(e, "Couldn't start the scans."));
    } finally {
      scanning = false;
    }
  }

  // --- Add a prospect by hand ---
  let adding = $state(false);
  let saving = $state(false);
  const blank = () => ({ business_name: "", website: "", email: "", contact_name: "", phone: "", city: "", industry: "" });
  let form = $state(blank());
  async function addProspect(e: SubmitEvent) {
    e.preventDefault();
    if (!form.business_name.trim()) return;
    saving = true;
    try {
      const input: ProspectInput = {
        business_name: form.business_name.trim(), website: form.website.trim() || null, domain: null,
        contact_name: form.contact_name.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null,
        city: form.city.trim() || null, region: null, industry: form.industry.trim() || null, source: "manual", source_ref: null, notes: null,
      };
      const id = await db.createProspect(input);
      adding = false; form = blank();
      onchanged?.();
      toast.success("Prospect added.");
      openProspect(id);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't add the prospect."));
    } finally {
      saving = false;
    }
  }

  // --- Find businesses (Yelp / Google Places) ---
  let discovering = $state(false);
  let dBusy = $state(false);
  let autoScan = $state(true);
  let dForm = $state<DiscoverParams>({ term: "", location: "", limit: 10, source: "yelp" });
  async function runDiscover(e: SubmitEvent) {
    e.preventDefault();
    if (!dForm.term.trim() || !dForm.location.trim()) return;
    dBusy = true;
    try {
      const { found, added } = await db.discoverProspects({ ...dForm, term: dForm.term.trim(), location: dForm.location.trim() });
      discovering = false;
      onchanged?.();
      // Auto-scan the fresh finds: scanProspects(null) queues a passive scan for
      // every prospect with a website that hasn't been audited yet, then one
      // dispatch drains the queue. Scanning is a bonus, so a hiccup here never
      // turns the discovery itself into an error.
      let scanMsg = "";
      if (added > 0 && autoScan) {
        try {
          const n = await db.scanProspects(null, false);
          if (n > 0) { await db.scanQueue(); scanMsg = ` Scanning ${n} now.`; }
        } catch {
          scanMsg = " You can scan them from the list.";
        }
        onchanged?.();
      }
      toast.success(added
        ? `Added ${added} new ${added === 1 ? "business" : "businesses"} (${found} found).${scanMsg}`
        : `No new businesses (all ${found} were already on your list).`);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't run discovery."));
    } finally {
      dBusy = false;
    }
  }

  // --- Quick scan one URL, then choose to add it ---
  let quickOpen = $state(false);
  let qUrl = $state("");
  let qRunning = $state(false);
  let qResult = $state<QuickScanResult | null>(null);
  let qAdding = $state(false);
  const qProblems = $derived((qResult?.findings ?? []).filter((f) => !f.passed && f.severity !== "info"));

  function openQuick() { quickOpen = true; qUrl = ""; qResult = null; }
  async function runQuickScan(e: SubmitEvent) {
    e.preventDefault();
    const u = qUrl.trim();
    if (!u || qRunning) return;
    qRunning = true;
    qResult = null;
    try {
      qResult = await db.quickScan(u);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't run the quick scan."));
    } finally {
      qRunning = false;
    }
  }
  async function addFromQuick() {
    if (!qResult || qAdding) return;
    qAdding = true;
    const r = qResult;
    try {
      const id = await db.createProspect({
        business_name: r.domain, website: r.target, domain: r.domain, contact_name: null, email: null,
        phone: null, city: null, region: null, industry: null, source: "manual", source_ref: null, notes: null,
      });
      // Add first, then run a full audit so the branded PDF and report exist. The
      // prospect stays added even if the scan can't start right now.
      try { if (await db.scanProspects([id], true)) await db.scanQueue(); } catch { /* added regardless */ }
      quickOpen = false; qResult = null; qUrl = "";
      onchanged?.();
      toast.success("Added as a lead. A full audit is running.");
      openProspect(id);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't add it as a lead."));
    } finally {
      qAdding = false;
    }
  }

  // --- CSV import ---
  let fileInput: HTMLInputElement;
  async function importCsv(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) fileInput.value = "";
    if (!file) return;
    try {
      const rowsIn = parseCsv(await file.text());
      if (!rowsIn.length) { toast.error("That file had no rows I could read. Expected a header row with at least business_name."); return; }
      const have = new Set(prospects.map((p) => p.domain).filter(Boolean));
      const toAdd: ProspectInput[] = [];
      let skipped = 0;
      for (const r of rowsIn) {
        const website = r.website ? (/^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`) : "";
        let domain: string | null = null;
        if (website) { try { domain = new URL(website).hostname.replace(/^www\./, "").toLowerCase(); } catch { domain = null; } }
        if (domain && have.has(domain)) { skipped++; continue; }
        if (domain) have.add(domain);
        toAdd.push({ business_name: r.business_name ?? "", website: website || null, domain, contact_name: r.contact_name || null, email: r.email || null, phone: r.phone || null, city: r.city || null, region: r.region || null, industry: r.industry || null, source: "csv", source_ref: null, notes: null });
      }
      if (!toAdd.length) { toast.info("Nothing to import", `All ${rowsIn.length} rows were already on your list.`); return; }
      const added = await db.importProspects(toAdd);
      onchanged?.();
      toast.success(`Imported ${added} ${added === 1 ? "prospect" : "prospects"}${skipped ? `, skipped ${skipped} already on the list` : ""}.`);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't import that file."));
    }
  }

  /** A small CSV reader: a header row, commas, and optional double quotes. */
  function parseCsv(csvText: string): Record<string, string>[] {
    const rows: string[][] = [];
    let row: string[] = [], cell = "", inQ = false;
    const t = csvText.replace(/\r\n?/g, "\n");
    for (let i = 0; i < t.length; i++) {
      const c = t[i]!;
      if (inQ) {
        if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const alias: Record<string, string> = { name: "business_name", business: "business_name", company: "business_name", url: "website", site: "website", web: "website", state: "region", category: "industry", type: "industry" };
    return rows
      .filter((r) => r.some((c) => c.trim()))
      .map((r) => {
        const o: Record<string, string> = {};
        header.forEach((h, i) => { o[alias[h] ?? h] = (r[i] ?? "").trim(); });
        return o;
      })
      .filter((o) => o.business_name);
  }
</script>

<PageHeader title="Prospects" sub="Local businesses to audit and reach out to">
  <input class="input search" type="search" placeholder="Search prospects" aria-label="Search prospects by name, domain, email, city or industry" bind:value={q} />
  <button class="btn" onclick={openQuick}>Quick scan</button>
  <button class="btn" onclick={() => (discovering = true)}>Find businesses</button>
  <button class="btn" onclick={() => fileInput.click()}>Import CSV</button>
  <button class="btn primary" onclick={() => (adding = true)}>Add prospect</button>
  <a class="btn ghost" href="#/prospects/settings" title="Audit settings">Settings</a>
</PageHeader>

<div class="filters">
  <div class="seg" role="group" aria-label="Status filter">
    <button aria-pressed={filter === "open"} onclick={() => (filter = "open")}>Open <span class="c">{OPEN_PROSPECT_STATUSES.reduce((s, st) => s + counts[st], 0)}</span></button>
    {#each PROSPECT_STATUSES as st (st)}
      <button aria-pressed={filter === st} onclick={() => (filter = st)}>{STATUS_LABEL[st]} <span class="c">{counts[st]}</span></button>
    {/each}
    <button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="c">{searched.length}</span></button>
    <button aria-pressed={filter === "archived"} onclick={() => (filter = "archived")}>Archived <span class="c">{searchedArchived.length}</span></button>
  </div>
  <div class="phonesort"><SortSelect id="prospect-sort" columns={COLUMNS} {sort} onchange={(s) => (sort = s)} /></div>
</div>

{#if selCount > 0}
  <div class="selbar" role="region" aria-label="Selected prospects">
    <span class="selcount">{selCount} selected</span>
    <div class="selacts">
      <button class="btn ghost sm" onclick={clearSelection}>Clear</button>
      <button class="btn primary sm" disabled={scanning} onclick={scanSelected}>{scanning ? "Starting…" : `Scan ${selCount} now`}</button>
    </div>
  </div>
{/if}

<section class="card flush">
  {#if rows.length}
    <div class="scroll">
      <table class="table cards">
        <caption class="sr-only">Prospects, sorted by {COLUMNS.find((c) => c.key === sort.key)!.label.toLowerCase()}. Column headings sort the table.</caption>
        <thead><tr>
          <th class="c-check" scope="col">
            <input type="checkbox" class="cbx" aria-label="Select every prospect with a website" checked={allSelected} indeterminate={someSelected && !allSelected} disabled={!scannable.length} onchange={toggleAll} />
          </th>
          {#each COLUMNS as c (c.key)}<SortTh key={c.key} label={c.label} {sort} onsort={sortBy} right={c.right} hide={c.hide ?? ""} />{/each}
        </tr></thead>
        <tbody>
          {#each rows as p (p.id)}
            {@const a = latest.m.get(p.id)}
            <tr class="link" class:sel={selected.has(p.id)} onclick={() => openProspect(p.id)}>
              <td class="c-check" onclick={(e) => e.stopPropagation()}>
                {#if p.website}
                  <input type="checkbox" class="cbx" aria-label={`Select ${p.business_name}`} checked={selected.has(p.id)} onchange={() => toggle(p.id)} />
                {/if}
              </td>
              <td class="c-main">
                <a class="who" href="#/prospects/{p.id}" onclick={(e) => e.stopPropagation()}>
                  <strong>{p.business_name}</strong>
                  <span class="muted">{p.domain ?? p.website ?? "no website yet"}</span>
                </a>
              </td>
              <td class="c-status"><StatusPill status={p.status} /></td>
              <td class="c-grade">
                {#if a && a.scan_status === "done"}<GradePill grade={a.grade} score={a.score} size="sm" />
                {:else if a && (a.scan_status === "queued" || a.scan_status === "running")}<span class="muted small">{STATUS_LABEL[a.scan_status]}…</span>
                {:else if a && a.scan_status === "failed"}<span class="small bad">Scan failed</span>
                {:else}<span class="muted small">No audit</span>{/if}
              </td>
              <td class="hide-sm muted c-loc">{[p.city, p.industry].filter(Boolean).join(" · ") || "—"}</td>
              <td class="r num hide-sm c-count">{latest.n.get(p.id) ?? 0}</td>
              <td class="r muted hide-sm c-ago">{ago(p.updated_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if filter === "archived" && !q}
    <EmptyState title="No archived prospects" text="Archiving a prospect (from its page) takes it off the list without deleting it." />
  {:else if !prospects.length}
    <EmptyState title="No prospects yet">
      <div class="emptyacts">
        <button class="btn primary sm" onclick={() => (adding = true)}>Add one by hand</button>
        <button class="btn sm" onclick={() => (discovering = true)}>Find local businesses</button>
      </div>
    </EmptyState>
  {:else}
    <EmptyState title="No prospects match">
      {#if q}<button class="btn sm" onclick={() => (q = "")}>Clear search</button>{/if}
      {#if filter !== "all" && searched.length}<button class="btn sm" onclick={() => (filter = "all")}>Show all prospects</button>{/if}
    </EmptyState>
  {/if}
</section>

<input bind:this={fileInput} type="file" accept=".csv,text/csv" class="sr-only" onchange={importCsv} aria-hidden="true" tabindex="-1" />

<Modal open={adding} title="Add a prospect" onclose={() => (adding = false)}>
  <form class="stack" onsubmit={addProspect}>
    <Field id="p-name" label="Business name" required><input id="p-name" class="input" bind:value={form.business_name} maxlength="200" required /></Field>
    <Field id="p-web" label="Website" hint="We audit this. The domain is read from it."><input id="p-web" class="input" bind:value={form.website} placeholder="example.com" maxlength="300" /></Field>
    <div class="two">
      <Field id="p-contact" label="Contact name"><input id="p-contact" class="input" bind:value={form.contact_name} maxlength="160" /></Field>
      <Field id="p-email" label="Email" hint="Where an audit would be sent"><input id="p-email" class="input" type="email" bind:value={form.email} maxlength="254" /></Field>
    </div>
    <div class="two">
      <Field id="p-city" label="City"><input id="p-city" class="input" bind:value={form.city} maxlength="120" /></Field>
      <Field id="p-industry" label="Industry"><input id="p-industry" class="input" bind:value={form.industry} maxlength="120" /></Field>
    </div>
    <Field id="p-phone" label="Phone"><input id="p-phone" class="input" bind:value={form.phone} maxlength="40" /></Field>
    <div class="actions">
      <button type="button" class="btn" onclick={() => (adding = false)}>Cancel</button>
      <button class="btn primary" disabled={saving || !form.business_name.trim()}>{saving ? "Adding…" : "Add prospect"}</button>
    </div>
  </form>
</Modal>

<Modal open={discovering} title="Find local businesses" onclose={() => (discovering = false)}>
  <form class="stack" onsubmit={runDiscover}>
    <p class="muted hint">Searches a business directory and adds the matches as prospects. With auto-scan on, each new one with a website gets a passive external audit right away.</p>
    <div class="two">
      <Field id="d-term" label="What" required><input id="d-term" class="input" bind:value={dForm.term} placeholder="dentist, law firm, HVAC…" required /></Field>
      <Field id="d-loc" label="Where" required><input id="d-loc" class="input" bind:value={dForm.location} placeholder="Pasadena, CA" required /></Field>
    </div>
    <div class="two">
      <Field id="d-src" label="Source"><select id="d-src" class="input" bind:value={dForm.source}><option value="yelp">Yelp</option><option value="google_places">Google Places</option></select></Field>
      <Field id="d-lim" label="How many"><input id="d-lim" class="input" type="number" min="1" max="50" bind:value={dForm.limit} /></Field>
    </div>
    <label class="chk"><input type="checkbox" bind:checked={autoScan} /> <span>Scan each new business automatically <span class="muted">(passive external check, no permission needed)</span></span></label>
    <div class="actions">
      <button type="button" class="btn" onclick={() => (discovering = false)}>Cancel</button>
      <button class="btn primary" disabled={dBusy || !dForm.term.trim() || !dForm.location.trim()}>{dBusy ? "Searching…" : "Find businesses"}</button>
    </div>
  </form>
</Modal>

<Modal open={quickOpen} title="Quick scan" onclose={() => (quickOpen = false)}>
  <form class="stack" onsubmit={runQuickScan}>
    <p class="muted hint">Scan one website's public security posture right now. Nothing is saved until you add it as a lead.</p>
    <Field id="q-url" label="Website" required><input id="q-url" class="input" bind:value={qUrl} placeholder="example.com" maxlength="300" required /></Field>
    {#if !qResult && !qRunning}
      <div class="actions"><button class="btn primary" disabled={!qUrl.trim()}>Scan</button></div>
    {/if}
  </form>

  {#if qRunning}
    <div class="qstate"><span class="spinner" aria-hidden="true"></span> <span>Checking the public posture…</span></div>
  {:else if qResult}
    {@const r = qResult}
    {#if r.reachable && r.grade}
      <div class="qhead">
        <GradePill grade={r.grade} score={r.score} size="lg" />
        <div class="qhead-txt">
          <strong>{r.summary}</strong>
          <span class="muted small">{r.domain} · {qProblems.length} {qProblems.length === 1 ? "issue" : "issues"}</span>
        </div>
      </div>
      {#if qProblems.length}
        <ul class="qfindings">
          {#each qProblems as f (f.id)}
            <li><span class="dot sev-{f.severity}" aria-hidden="true"></span><span class="qf-title">{f.title}</span><span class="qf-cat">{f.category}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="empty">No external issues found. A clean public posture.</p>
      {/if}
      {#if r.notes.length}<p class="qnote muted small">{r.notes[0]}</p>{/if}
    {:else}
      <p class="qunreach">{r.notes[0] ?? "Couldn't load the site over HTTPS."}</p>
    {/if}
    <div class="actions">
      <button type="button" class="btn" onclick={() => { qResult = null; qUrl = ""; }}>Scan another</button>
      <button type="button" class="btn primary" disabled={qAdding} onclick={addFromQuick}>{qAdding ? "Adding…" : "Add as lead"}</button>
    </div>
  {/if}
</Modal>

<style>
  .filters { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  .filters .seg { flex-wrap: wrap; border-radius: var(--radius); }
  .phonesort { display: none; }
  .scroll { overflow-x: auto; }
  .small { font-size: var(--fs-xs); }
  .bad { color: #ff6b6b; }
  .selbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; padding: 8px 10px 8px 14px; border: 1px solid var(--line-2); border-radius: var(--radius-md); background: var(--surface-2); }
  .selcount { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
  .selacts { display: flex; gap: 8px; }
  .c-check { width: 36px; text-align: center; padding-right: 0; }
  .cbx { width: 16px; height: 16px; cursor: pointer; accent-color: var(--lime); vertical-align: middle; margin: 0; }
  .cbx:disabled { cursor: default; opacity: 0.35; }
  tr.sel { background: color-mix(in srgb, var(--lime) 8%, transparent); }
  .chk { display: flex; align-items: flex-start; gap: 8px; font-size: var(--fs-sm); cursor: pointer; line-height: 1.45; }
  .chk input { margin: 2px 0 0; accent-color: var(--lime); width: 15px; height: 15px; flex: none; }
  .emptyacts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { font-size: var(--fs-sm); margin: -2px 0 2px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  /* Quick scan modal */
  .qstate { display: flex; align-items: center; gap: 10px; padding: 20px 2px; color: var(--text-2); font-size: var(--fs-sm); }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--line-2); border-top-color: var(--lime); border-radius: 50%; animation: spin 0.7s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .qhead { display: flex; align-items: center; gap: 14px; padding: 14px 0 8px; }
  .qhead-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .qhead-txt strong { font-weight: 600; }
  .qfindings { list-style: none; display: flex; flex-direction: column; margin-top: 2px; }
  .qfindings li { display: flex; align-items: center; gap: 9px; padding: 9px 2px; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
  .qf-title { flex: 1; min-width: 0; }
  .qf-cat { font-size: var(--fs-xs); color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.sev-critical { background: #ff6b6b; }
  .dot.sev-high { background: #ff8f5a; }
  .dot.sev-medium { background: var(--warning); }
  .dot.sev-low { background: var(--st-contacted); }
  .dot.sev-info { background: var(--muted); }
  .qnote { margin-top: 12px; }
  .qunreach { padding: 16px 0; font-size: var(--fs-sm); color: var(--text-2); }
  @media (max-width: 860px) {
    .filters { flex-direction: column; align-items: stretch; }
    .filters .seg { flex-wrap: nowrap; border-radius: var(--radius-pill); overflow-x: auto; scroll-snap-type: x proximity; }
    .filters .seg button { scroll-snap-align: start; white-space: nowrap; }
    .phonesort { display: block; }
  }
  @media (max-width: 640px) {
    .two { grid-template-columns: 1fr; }
    .table td.c-count { display: none; }
    /* On the card layout the checkbox floats in the top-right corner, out of the
       grid flow, so it never pushes the business name onto a line of its own. */
    .table.cards tbody tr { position: relative; }
    .table.cards td.c-check { position: absolute; top: 12px; right: 10px; width: auto; }
    .table.cards td.c-main { padding-right: 26px; }
  }
</style>
