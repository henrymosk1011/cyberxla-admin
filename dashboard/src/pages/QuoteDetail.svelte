<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import db from "$db";
  import Confirm from "../components/Confirm.svelte";
  import Menu, { type MenuItem } from "../components/Menu.svelte";
  import Modal from "../components/Modal.svelte";
  import Field from "../components/Field.svelte";
  import LoadState from "../components/LoadState.svelte";
  import QuotePreview from "../components/QuotePreview.svelte";
  import SendDialog from "../components/SendDialog.svelte";
  import { tick, untrack } from "svelte";
  import { leave, pageHeading } from "../lib/nav.svelte.ts";
  import { messageOf, toast } from "../lib/toast.svelte.ts";
  import { catalog } from "../lib/store.svelte.ts";
  import { dateTime, shortDate } from "../lib/format.ts";
  import { unitPrice, isMonthly } from "../lib/catalog.ts";
  import { ownerOptions, parseOwner, ownerValue } from "../lib/projects.ts";
  import { BadDoc, addonsFor, newKey, normalizeDoc, resolveDoc, tierBilling, tierMargin, totals, usd, varsFor, cents, longDate, PLACEHOLDERS, type Addon, type ProposalDoc, type Row, type Tier, type TierBilling } from "../../../supabase/functions/_shared/proposal.ts";
  import { clientLink, statusLabel, describeEvent, isEditable, ownerOf, previewModel, projectLines, quoteNo, safeDoc, selectionText, viewAsClient } from "../lib/quotes.ts";
  import type { Client, Lead, Payment, Project, Proposal, ProposalAcceptance, ProposalEvent, ProposalVersion, QuoteSettings, ServiceRow } from "../lib/types.ts";

  let { id, version, clients, leads, projects, onchanged, autosend = false }: { id: string; version: number; clients: Client[]; leads: Lead[]; projects: Project[]; onchanged: () => void; autosend?: boolean } = $props();

  type Draft = {
    owner: string; title: string; recipient_name: string; recipient_email: string; cc: string; prepared_on: string; valid_until: string;
    content: ProposalDoc; costs: Record<string, number | null>; links: Record<string, string>; internal_notes: string; reminders: boolean;
  };

  let p = $state<Proposal | null | undefined>(undefined);
  let events = $state<ProposalEvent[]>([]);
  let versions = $state<ProposalVersion[]>([]);
  let acceptances = $state<ProposalAcceptance[]>([]);
  let payments = $state<Payment[]>([]);
  let settings = $state<QuoteSettings | null>(null);
  let loadError = $state("");
  let draft = $state<Draft | null>(null);
  let savedKey = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let savedAt = $state(0);
  let busy = $state(false);
  let confirm: Confirm;
  let tab = $state<"edit" | "preview">("edit");

  // The editor's sections, one tab each. The last one used is remembered while you work.
  const SECTIONS = [
    { id: "client", label: "Client" }, { id: "details", label: "Details" }, { id: "tiers", label: "Tiers" },
    { id: "rows", label: "Comparison rows" }, { id: "addons", label: "Add ons" }, { id: "pricing", label: "Pricing" },
    { id: "fine", label: "Fine print" }, { id: "notes", label: "Notes" }, { id: "history", label: "History" },
  ] as const;
  type SectionId = (typeof SECTIONS)[number]["id"];
  const savedSection = (() => { try { const v = sessionStorage.getItem("quote.section"); return SECTIONS.some((x) => x.id === v) ? (v as SectionId) : null; } catch { return null; } })();
  let sec = $state<SectionId>(savedSection ?? "client");
  function pickSection(id: SectionId) {
    sec = id;
    try { sessionStorage.setItem("quote.section", id); } catch { /* not remembered; fine */ }
  }
  // Arrow keys, Home and End move between the tabs (the ARIA tabs pattern).
  function sectionKeys(e: KeyboardEvent) {
    const i = SECTIONS.findIndex((x) => x.id === sec);
    const next = e.key === "ArrowRight" ? (i + 1) % SECTIONS.length : e.key === "ArrowLeft" ? (i - 1 + SECTIONS.length) % SECTIONS.length
      : e.key === "Home" ? 0 : e.key === "End" ? SECTIONS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    pickSection(SECTIONS[next]!.id);
    document.getElementById(`qt-${SECTIONS[next]!.id}`)?.focus();
  }
  /** Show a section's tab, then focus a field in it. */
  async function showField(id: SectionId, elId: string) {
    pickSection(id);
    await tick();
    document.getElementById(elId)?.focus();
  }
  let sending = $state<"" | "send" | "resend">("");
  let converting = $state(false);
  let templating = $state(false);
  let templateName = $state("");
  let versionShown = $state<ProposalVersion | null>(null);
  let picking = $state<"" | "tier" | "row" | "addon">("");
  let search = $state("");
  let openRows = $state<Record<string, boolean>>({});
  let newLead = $state<{ name: string; company: string; email: string } | null>(null);
  // Leads added here show in the list right away, before the app reloads its lists.
  let extraLeads = $state<Lead[]>([]);
  const allLeads = $derived([...leads, ...extraLeads.filter((x) => !leads.some((l) => l.id === x.id))]);

  // ---------------------------------------------------------------------------
  // Loading and the editable copy
  // ---------------------------------------------------------------------------
  function draftFrom(x: Proposal): Draft {
    const costs: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(x.internal.costs ?? {})) costs[k] = v;
    return {
      owner: ownerValue(x), title: x.title, recipient_name: x.recipient_name, recipient_email: x.recipient_email ?? "", cc: x.cc.join(", "),
      prepared_on: x.prepared_on, valid_until: x.valid_until, content: structuredClone(x.content), costs, links: { ...(x.internal.links ?? {}) },
      internal_notes: x.internal_notes ?? "", reminders: x.reminders,
    };
  }
  const keyOf = (d: Draft) => JSON.stringify(d);

  async function load(first = false) {
    try {
      const [x, ev, vs, ac, st, pay] = await Promise.all([db.proposal(id), db.proposalEvents(id), db.proposalVersions(id), db.proposalAcceptances(id), db.quoteSettings(), db.payments()]);
      p = x; events = ev; versions = vs; acceptances = ac; settings = st; payments = pay.filter((m) => m.proposal_id === id);
      loadError = "";
      // The form fills in on the first load, and after changes made elsewhere when nothing is unsaved here.
      if (x && (first || !draft || (!dirty && !saving))) {
        draft = draftFrom(x);
        savedKey = keyOf(draft);
      }
    } catch (e) {
      const m = messageOf(e, "Check your connection and try again.");
      if (p === undefined) loadError = m; else toast.error(`Couldn't refresh this quote. ${m}`);
    }
  }
  $effect(() => { void id; load(true); });
  // From the list's Send: open the Send dialog once the quote is in.
  let autoDone = false;
  $effect(() => {
    if (!autosend || autoDone || !p || !settings) return;
    autoDone = true;
    history.replaceState(history.state, "", `#/quotes/${id}`);
    openSend(isEditable(p) ? "send" : "resend");
  });
  // The app's lists refreshed: refresh this quote too (reading p untracked, or each load would start another).
  $effect(() => { void version; untrack(() => { if (p) load(); }); });
  $effect(() => db.subscribeProposals(() => { if (!saving) load(); }));

  // ---------------------------------------------------------------------------
  // Saving (automatic, about a second after you stop typing)
  // ---------------------------------------------------------------------------
  const editable = $derived(!!p && isEditable(p));
  const dirty = $derived(!!draft && keyOf(draft) !== savedKey);
  const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
  const ccList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

  const problem = $derived.by(() => {
    if (!draft || !p) return "";
    if (editable) {
      if (!draft.title.trim()) return "Give the quote a title.";
      try { normalizeDoc(draft.content); } catch (e) { if (e instanceof BadDoc) return e.message; throw e; }
    }
    if (draft.recipient_email.trim() && !EMAIL.test(draft.recipient_email.trim())) return "Check the recipient's email.";
    const cc = ccList(draft.cc);
    if (cc.length > 5) return "Up to 5 cc addresses.";
    const bad = cc.find((x) => !EMAIL.test(x));
    if (bad) return `Check the cc address ${bad}.`;
    if (!draft.valid_until) return "Pick a valid until date.";
    for (const [k, v] of Object.entries(draft.costs)) if (v !== null && (typeof v !== "number" || v < 0 || !Number.isFinite(v))) return `Check the internal cost for ${k.split(":")[1]}.`;
    return "";
  });

  function patchFrom(d: Draft, x: Proposal) {
    const costs: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.costs)) if (typeof v === "number" && v > 0) costs[k] = Math.round(v * 100) / 100;
    const patch: Parameters<typeof db.updateProposal>[1] = {
      recipient_name: d.recipient_name.trim(), recipient_email: d.recipient_email.trim().toLowerCase() || null, cc: ccList(d.cc),
      internal: { costs, links: { ...d.links } }, internal_notes: d.internal_notes.trim() || null, reminders: d.reminders,
    };
    if (x.status !== "accepted" || x.revising) patch.valid_until = d.valid_until;
    if (isEditable(x)) Object.assign(patch, { title: d.title.trim(), prepared_on: d.prepared_on, content: normalizeDoc(d.content) });
    if (x.version === 0) { const o = parseOwner(d.owner); if (o) Object.assign(patch, o); }
    return patch;
  }

  // One save at a time; a save asked for while one runs waits for it, then saves what's left.
  let inflight: Promise<boolean> | null = null;
  async function save(): Promise<boolean> {
    while (inflight) await inflight;
    if (!draft || !p) return true;
    const k = keyOf(draft);
    if (k === savedKey) return true;
    if (problem) { saveError = ""; return false; }
    const x0 = p;
    inflight = (async () => {
      saving = true;
      try {
        await db.updateProposal(x0.id, patchFrom(draft!, x0));
        savedKey = k; saveError = ""; savedAt = Date.now();
        const [x, ev] = await Promise.all([db.proposal(id), db.proposalEvents(id)]);
        p = x; events = ev;
        return true;
      } catch (e) {
        saveError = messageOf(e, "Couldn't save. Check your connection.");
        return false;
      } finally {
        saving = false;
      }
    })();
    const ok = await inflight;
    inflight = null;
    return ok;
  }
  $effect(() => {
    if (!draft || !p) return;
    const k = keyOf(draft);
    if (k === savedKey || problem) return;
    const t = setTimeout(save, 1100);
    return () => clearTimeout(t);
  });
  // Leaving with edits that haven't saved yet: save them first, and ask only if that fails.
  $effect(() => {
    if (!dirty && !saving) return;
    const ask = async () => (await save()) || confirm.ask({ title: "Leave without saving?", body: problem ? `This quote can't save yet: ${problem}` : saveError || "Your latest edits haven't saved.", action: "Leave", danger: true });
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    leave.guard = ask;
    return () => { window.removeEventListener("beforeunload", onUnload); if (leave.guard === ask) leave.guard = null; };
  });
  const saveText = $derived(saving ? "Saving…" : problem ? `Can't save yet: ${problem}` : saveError ? saveError : dirty ? "Unsaved changes" : savedAt ? "All changes saved" : "Saved");

  // ---------------------------------------------------------------------------
  // Who it's for, the preview, margins
  // ---------------------------------------------------------------------------
  const owner = $derived(draft ? ownerOf(parseOwner(draft.owner) ?? { client_id: null, lead_id: null }, clients, allLeads) : null);
  const choices = $derived(ownerOptions(clients, allLeads, p ?? undefined));
  let lastGood: ProposalDoc | null = null;
  const doc = $derived.by(() => {
    if (!draft) return null;
    const d = safeDoc(draft.content);
    if (d) lastGood = d;
    return d ?? lastGood;
  });
  const vars = $derived(p && draft ? varsFor({ number: p.number, company: owner?.company ?? null, contact_name: draft.recipient_name || owner?.contact || null, valid_until: draft.valid_until }) : null);
  const titleFilled = $derived(draft && vars ? draft.title.replace(/\{(company|contact_first_name|quote_number|valid_until)\}/g, (_, k: keyof typeof vars) => vars[k]) : "");
  const model = $derived.by(() => {
    if (versionShown) return { ...previewModel({ number: p!.number, version: versionShown.version - 1, title: versionShown.header.title, owner, recipientName: draft?.recipient_name ?? "", preparedOn: versionShown.header.prepared_on, validUntil: versionShown.header.valid_until, doc: versionShown.content, settings }), title: versionShown.header.title, prepared_for: versionShown.header.prepared_for };
    if (!p || !draft || !doc) return null;
    return previewModel({ number: p.number, version: p.version, title: draft.title, owner, recipientName: draft.recipient_name, preparedOn: draft.prepared_on, validUntil: draft.valid_until, doc, settings });
  });
  const internal = $derived({ costs: Object.fromEntries(Object.entries(draft?.costs ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number> });
  const hasCosts = $derived(Object.values(internal.costs).some((v) => v > 0));

  // When the client or lead changes on a new quote, fill in who it goes to.
  function pickOwner(v: string) {
    if (!draft) return;
    if (v === "new") { newLead = { name: "", company: "", email: "" }; return; }
    draft.owner = v;
    const o = ownerOf(parseOwner(v)!, clients, allLeads);
    if (o && !draft.recipient_email) { draft.recipient_email = o.email ?? ""; draft.recipient_name = o.contact ?? ""; }
  }
  async function createLead() {
    if (!newLead || !draft) return;
    if (!newLead.name.trim() || !EMAIL.test(newLead.email.trim())) { toast.error("A new lead needs a name and a valid email."); return; }
    busy = true;
    try {
      const lid = await db.createLead({ name: newLead.name.trim(), company: newLead.company.trim() || null, email: newLead.email.trim(), phone: null });
      extraLeads.push({ id: lid, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), name: newLead.name.trim(), company: newLead.company.trim() || null, email: newLead.email.trim().toLowerCase(), phone: null, status: "new", source: "manual", value_monthly: 0, value_one_time: 0, archived_at: null });
      draft.owner = `lead:${lid}`; draft.recipient_name = newLead.name.trim(); draft.recipient_email = newLead.email.trim().toLowerCase();
      newLead = null;
      onchanged();
      toast.success("Lead added.");
    } catch (e) {
      toast.error(messageOf(e, "Couldn't add the lead."));
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Editing the document
  // ---------------------------------------------------------------------------
  const keysOf = (c: ProposalDoc) => [...c.tiers.map((t) => t.key), ...c.rows.map((r) => r.key), ...c.addons.map((a) => a.key), ...c.fine_print.map((f) => f.key)];
  const mkKey = () => newKey(keysOf(draft!.content));
  function move<T>(list: T[], i: number, j: number) {
    if (j < 0 || j >= list.length || i === j) return;
    const [x] = list.splice(i, 1);
    list.splice(j, 0, x!);
  }
  function addTier(from?: ServiceRow) {
    const c = draft!.content, key = mkKey();
    // A monthly catalog service makes a monthly tier.
    const mo = !!from && isMonthly(from.unit);
    c.tiers.push({ key, name: from?.name.replace(/^.*?,\s*/, "") ?? `Tier ${c.tiers.length + 1}`, price: mo ? 0 : from?.price ?? 0, discount: null, monthly: mo ? from!.price : null, monthly_discount: null, summary: from?.description.slice(0, 240) ?? "" });
    for (const r of c.rows) r.values[key] = false;
    for (const a of c.addons) a.tiers[key] = "available";
    if (from) draft!.links[`tier:${key}`] = from.id;
  }
  function removeTier(i: number) {
    const c = draft!.content;
    if (c.tiers.length === 1) return;
    const [t] = c.tiers.splice(i, 1);
    if (c.recommended === t!.key) c.recommended = null;
    if (c.default_tier === t!.key) c.default_tier = c.tiers[0]!.key;
  }
  function addRow(from?: ServiceRow) {
    const c = draft!.content, key = mkKey();
    c.rows.push({ key, label: from?.name ?? "", explain: from?.description ?? "", values: Object.fromEntries(c.tiers.map((t) => [t.key, true])) });
    if (from) draft!.links[`row:${key}`] = from.id;
    openRows[key] = true;
    focusLater(`row-${key}-label`);
  }
  function duplicateRow(i: number) {
    const c = draft!.content, r = c.rows[i]!, key = mkKey();
    c.rows.splice(i + 1, 0, { ...structuredClone($state.snapshot(r)), key, label: `${r.label} (copy)`.slice(0, 120) });
    openRows[key] = true;
  }
  function addAddon(from?: ServiceRow) {
    const c = draft!.content, key = mkKey();
    c.addons.push({ key, name: from?.name ?? "", description: from?.description ?? "", price: from?.price ?? 0, billing: from && isMonthly(from.unit) ? "monthly" : "once", discount: null, tiers: Object.fromEntries(c.tiers.map((t) => [t.key, "available"])) });
    if (from) draft!.links[`addon:${key}`] = from.id;
    focusLater(`addon-${key}-name`);
  }
  function addFine() {
    const c = draft!.content;
    c.fine_print.push({ key: mkKey(), text: "", tiers: [], addon: null });
  }
  async function focusLater(elId: string) { await tick(); document.getElementById(elId)?.focus(); }
  const setCell = (r: Row, tier: string, on: boolean) => { const v = r.values[tier]; r.values[tier] = on ? (typeof v === "string" && v ? v : true) : false; };
  const setCellText = (r: Row, tier: string, text: string) => { r.values[tier] = text ? text : true; };
  const cellText = (v: unknown) => (typeof v === "string" ? v : "");
  const isOn = (v: unknown) => v === true || (typeof v === "string" && v !== "");

  /** Turn a discount on or off for an item. */
  // How each tier is billed. It follows from the prices (tierBilling); what you
  // pick here wins while you type, so a monthly price of 0 doesn't flip it back.
  let billingPick = $state<Record<string, TierBilling>>({});
  const billingOf = (t: Tier) => billingPick[t.key] ?? tierBilling(t);
  function setBilling(t: Tier, b: TierBilling) {
    billingPick[t.key] = b;
    if (b === "once") {
      t.monthly = null;
      t.monthly_discount = null;
      return;
    }
    if (t.monthly === null) t.monthly = 0;
    if (b === "monthly") {
      t.price = 0;
      t.discount = null;
    }
  }

  function toggleDiscount(obj: { discount: Tier["discount"] } | { monthly_discount: Tier["discount"] }, field: "discount" | "monthly_discount", on: boolean) {
    (obj as Record<string, unknown>)[field] = on ? { kind: "percent", value: 10 } : null;
  }

  // Dragging a row by its handle, or moving it with the arrow keys.
  let rowsEl = $state<HTMLElement | null>(null);
  function startRowDrag(e: PointerEvent, key: string) {
    if (!editable || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rows = draft!.content.rows;
      const from = rows.findIndex((r) => r.key === key);
      const els = [...(rowsEl?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      const to = els.filter((el) => el.dataset.row !== key && el.getBoundingClientRect().top + el.offsetHeight / 2 < ev.clientY).length;
      if (to !== from) move(rows, from, to);
    };
    const end = () => { handle.removeEventListener("pointermove", onMove); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  async function rowKey(e: KeyboardEvent, i: number, key: string) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    move(draft!.content.rows, i, i + (e.key === "ArrowUp" ? -1 : 1));
    await tick();
    rowsEl?.querySelector<HTMLElement>(`[data-grip="${key}"]`)?.focus();
  }

  // The catalog: pick a service to add as a tier, a row or an add on.
  const pickList = $derived.by(() => {
    const s = search.trim().toLowerCase();
    return catalog.categories.map((c) => ({
      name: c.name,
      items: catalog.services.filter((x) => x.category_id === c.id && x.active && (!s || x.name.toLowerCase().includes(s) || c.name.toLowerCase().includes(s))),
    })).filter((c) => c.items.length);
  });
  function pick(svc: ServiceRow) {
    if (picking === "tier") addTier(svc);
    else if (picking === "row") addRow(svc);
    else if (picking === "addon") addAddon(svc);
    picking = ""; search = "";
  }
  const linked = (kind: "tier" | "row" | "addon", key: string) => {
    const sid = draft?.links[`${kind}:${key}`];
    return sid ? catalog.services.find((s) => s.id === sid) : undefined;
  };
  async function updateCatalogPrice(svc: ServiceRow, price: number) {
    if (!(await confirm.ask({ title: `Change ${svc.name} in the catalog?`, body: `Its catalog price goes from ${usd(cents(svc.price))} to ${usd(cents(price))}. The website's Build Your Quote page and new quotes use the catalog price. Quotes already made keep their own prices.`, action: "Update catalog price" }))) return;
    try {
      await db.saveService({ ...svc, price }, false);
      catalog.services = await db.services();
      toast.success(`${svc.name} now costs ${usd(cents(price))} in the catalog.`);
    } catch (e) {
      toast.error(messageOf(e, "Couldn't update the catalog."));
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function rpc(fn: Parameters<typeof db.proposalRpc>[0], args: Record<string, unknown>, ok: string) {
    busy = true;
    try {
      if (!(await save())) { toast.error(problem ? `Fix this first: ${problem}` : "Your edits haven't saved yet. Try again in a moment."); return null; }
      const out = await db.proposalRpc(fn, { p_id: id, ...args });
      if (ok) toast.success(ok);
      await load(true);
      onchanged();
      return out;
    } catch (e) {
      toast.error(messageOf(e, "That didn't go through. Try again."));
      return null;
    } finally {
      busy = false;
    }
  }
  async function openSend(mode: "send" | "resend") {
    if (mode === "send" && !(await save())) { toast.error(problem ? `Fix this first: ${problem}` : "Your edits haven't saved yet. Try again in a moment."); return; }
    if (!p?.recipient_email) { toast.error("Add the recipient's email first."); showField("client", "q-email"); return; }
    sending = mode;
    // Is email set up? The dialog offers Publish without emailing when it isn't.
    db.quoteAction({ action: "status" }).then((s) => (emailReady = s.email === true)).catch(() => (emailReady = null));
  }
  let emailReady = $state<boolean | null>(null);
  async function doPublish() {
    await db.proposalRpc("proposal_publish", { p_id: id });
    sending = "";
    let copied = false;
    try { await navigator.clipboard.writeText(clientLink(p!.token)); copied = true; } catch { /* the toast says how to copy it */ }
    toast.success(copied ? `${quoteNo(p!)} is live and its link is copied, ready to send.` : `${quoteNo(p!)} is live. Use Copy link to send it yourself.`);
    await load(true);
    onchanged();
  }
  async function doSend(subject: string, note: string) {
    const out = await db.quoteAction({ action: sending === "resend" ? "resend" : "send", id, subject, note });
    const to = (out.to as string[] | undefined)?.join(", ") ?? p?.recipient_email;
    sending = "";
    toast.success(`${quoteNo(p!)} was emailed to ${to}.`);
    await load(true);
    onchanged();
  }
  async function doSchedule(at: string, subject: string, note: string) {
    await db.proposalRpc("proposal_schedule", { p_id: id, p_at: at, p_subject: subject, p_note: note });
    sending = "";
    toast.success(`Scheduled for ${dateTime(at)}.`);
    await load(true);
    onchanged();
  }
  async function doTest(subject: string, note: string) {
    const out = await db.quoteAction({ action: "test", id, subject, note });
    load();
    return (out.to as string[] | undefined)?.join(", ") ?? settings?.notify_email ?? "you";
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(clientLink(p!.token));
      toast.success(p!.version ? "Link copied." : "Link copied. It works once the quote is sent.");
    } catch {
      toast.error("Couldn't copy. Your browser blocked the clipboard.");
    }
  }
  async function archive(on: boolean) {
    busy = true;
    try { await db.updateProposal(id, { archived_at: on ? new Date().toISOString() : null }); toast.success(on ? "Archived." : "Restored."); await load(true); onchanged(); }
    catch (e) { toast.error(messageOf(e, "That didn't go through.")); }
    finally { busy = false; }
  }
  async function remove() {
    if (!p) return;
    if (!(await confirm.ask({ title: `Delete ${quoteNo(p)}?`, body: p.version ? "This deletes the quote, its versions, timeline and any acceptance for good. Its number won't be used again." : "This deletes the draft for good. Its number won't be used again.", action: "Delete permanently", danger: true }))) return;
    try {
      leave.guard = null; savedKey = draft ? keyOf(draft) : savedKey;
      await db.deleteProposal(id);
      toast.success(`${quoteNo(p)} was deleted.`);
      onchanged();
      location.hash = "#/quotes";
    } catch (e) {
      toast.error(messageOf(e, "Couldn't delete it."));
    }
  }
  async function duplicate() {
    const nid = await rpc("proposal_duplicate", {}, "");
    if (typeof nid === "string") { toast.success("Copied to a new draft."); location.hash = `#/quotes/${nid}`; }
  }
  async function saveTemplate(e: SubmitEvent) {
    e.preventDefault();
    if (!draft || !templateName.trim()) return;
    try {
      await db.saveTemplate({ name: templateName.trim().slice(0, 80), title: draft.title.trim() || templateName.trim(), content: normalizeDoc(draft.content), internal: { costs: internal.costs, links: draft.links } });
      templating = false;
      toast.success(`Saved as the template "${templateName.trim()}".`);
    } catch (err) {
      toast.error(messageOf(err, "Couldn't save the template."));
    }
  }

  // Convert to project
  const project = $derived(projects.find((x) => x.proposal_id === id));
  const accepted = $derived(acceptances.find((a) => p && a.version === p.accepted_version) ?? null);
  let conv = $state({ tier: "", addons: [] as string[], lead: true });
  const lastVersion = $derived(versions[0] ?? null);
  function openConvert() {
    const d = accepted?.doc ?? lastVersion?.content;
    if (!d) return;
    conv = { tier: accepted?.tier ?? d.default_tier, addons: accepted ? [...accepted.addons] : [], lead: true };
    converting = true;
  }
  const convPlan = $derived.by(() => {
    if (accepted) return { lines: accepted.lines, once: Math.round(accepted.once_total * 100), monthly: Math.round(accepted.monthly_total * 100) };
    const d = lastVersion?.content;
    if (!d || !conv.tier) return null;
    const { lines, totals: t } = projectLines(d, conv.tier, conv.addons);
    return { lines, once: t.once_total, monthly: t.monthly_total };
  });
  async function doConvert() {
    if (!convPlan) return;
    const pid = await rpc("proposal_convert", { p_lines: accepted ? null : convPlan.lines, p_convert_lead: !!p?.lead_id && conv.lead }, "Project created.");
    if (typeof pid === "string") { converting = false; location.hash = `#/projects/${pid}`; }
  }

  const head = $derived.by(() => {
    if (!p) return "";
    const parts = [quoteNo(p)];
    if (p.version) parts.push(`version ${p.version}${p.revising ? `, revising version ${p.version + 1}` : ""}`);
    if (p.last_sent_at) parts.push(`${p.link_only ? "published" : "sent"} ${shortDate(p.last_sent_at)}`);
    if (p.view_count) parts.push(`viewed ${p.view_count} ${p.view_count === 1 ? "time" : "times"}${p.last_viewed_at ? `, last ${shortDate(p.last_viewed_at)}` : ""}`);
    return parts.join(" · ");
  });
  const lastChange = $derived(events.find((e) => e.kind === "changes_requested"));
  const more = $derived.by((): MenuItem[] => {
    if (!p) return [];
    const m: MenuItem[] = [];
    if (p.version) m.push({ label: "View as client", hint: "Doesn't count as a view", onselect: () => window.open(viewAsClient(p!.token), "_blank", "noopener") });
    m.push({ label: "Copy client link", onselect: copyLink });
    m.push({ label: "Duplicate", onselect: duplicate });
    m.push({ label: "Save as template", onselect: () => { templateName = draft?.title ?? ""; templating = true; } });
    if (p.version && p.status !== "accepted" && p.status !== "revoked") m.push({ label: p.link_only ? "Email it to the client" : "Email it again", onselect: () => openSend("resend") });
    if (["sent", "viewed", "changes_requested", "expired"].includes(p.status)) m.push({ label: "Mark declined", onselect: () => rpc("proposal_set_declined", { p_declined: true }, "Marked declined.") });
    if (p.version && p.status !== "revoked") m.push({ label: "Make a new link", hint: "The old link stops working", onselect: async () => { if (await confirm.ask({ title: "Make a new link?", body: "The link the client has stops working. Send or copy the new one.", action: "Make a new link" })) rpc("proposal_new_link", {}, "New link made."); } });
    if (p.version && p.status !== "revoked") m.push({ label: "Turn off the link", danger: true, onselect: async () => { if (await confirm.ask({ title: "Turn off the link?", body: "The client will see \"This quote isn't available\". You can make a new link later.", action: "Turn off", danger: true })) rpc("proposal_revoke", {}, "Link turned off."); } });
    m.push({ label: p.archived_at ? "Restore" : "Archive", onselect: () => archive(!p!.archived_at) });
    if (!p.version || p.archived_at) m.push({ label: "Delete", danger: true, onselect: remove });
    return m;
  });
  const tierName = (k: string, d: ProposalDoc | null | undefined) => d?.tiers.find((t) => t.key === k)?.name ?? k;
  const paid = $derived(payments.filter((m) => m.status === "paid").reduce((s, m) => s + m.amount, 0));
</script>

<a class="back" href="#/quotes"><Icon name="arrow-left" size={14} /> All quotes</a>

{#if p === undefined}
  <LoadState error={loadError} what="this quote" onretry={() => { loadError = ""; load(true); }} />
{:else if p === null || !draft}
  <p class="empty">This quote doesn't exist or was deleted.</p>
{:else}
  {@const d = draft}
  <header class="head">
    <div class="titles">
      <p class="eyebrow">{head}</p>
      <h1 use:pageHeading>{titleFilled || "Untitled quote"}</h1>
      <div class="state">
        <span class="pill st-{p.status}"><i aria-hidden="true"></i>{statusLabel(p)}</span>
        {#if p.revising}<span class="tag">Revising</span>{/if}
        {#if p.archived_at}<span class="tag">Archived</span>{/if}
        {#if owner}<a class="owner" href={owner.href}>{owner.kind}: {owner.label}</a>{/if}
        {#if project}<a class="owner" href="#/projects/{project.id}">Project: {project.name}</a>{/if}
      </div>
    </div>
    <div class="acts">
      <span class="saved" class:bad={!!problem || !!saveError} role="status">{saveText}</span>
      {#if p.status === "draft" || p.status === "scheduled"}
        <button class="btn primary" disabled={busy} onclick={() => openSend("send")}>{p.status === "scheduled" ? "Send now" : "Send"}</button>
      {:else if p.revising}
        <button class="btn" disabled={busy} onclick={() => rpc("proposal_discard_revision", {}, "Revision discarded.")}>Discard revision</button>
        <button class="btn primary" disabled={busy} onclick={() => openSend("send")}>Send revision</button>
      {:else if p.status === "revoked"}
        <button class="btn primary" disabled={busy} onclick={() => rpc("proposal_new_link", {}, "New link made. The quote is back on.")}>Make a new link</button>
      {:else if p.status === "declined"}
        <button class="btn" disabled={busy} onclick={() => rpc("proposal_set_declined", { p_declined: false }, "Reopened.")}>Reopen</button>
      {:else}
        <button class="btn" disabled={busy} onclick={() => rpc("proposal_revise", {}, "Revising. The client sees the sent version until you send this one.")}>Revise</button>
        {#if !project && ["accepted", "sent", "viewed", "changes_requested"].includes(p.status)}
          <button class="btn" class:primary={p.status === "accepted"} disabled={busy} onclick={openConvert}>Convert to project</button>
        {/if}
      {/if}
      <Menu label="More actions for {quoteNo(p)}" items={more} />
    </div>
  </header>

  {#if p.scheduled_at}
    <div class="callout" role="note"><strong>Scheduled to send {dateTime(p.scheduled_at)}.</strong> <p>To {p.recipient_email}. <button class="linkbtn" disabled={busy} onclick={() => rpc("proposal_unschedule", {}, "Schedule cancelled.")}>Cancel the schedule</button></p></div>
  {/if}
  {#if p.revising}
    <div class="callout warn" role="note"><strong>You're revising {quoteNo(p)}.</strong> <p>The client still sees version {p.version} until you send this revision. Same link, same number.</p></div>
  {:else if p.status === "accepted"}
    <div class="callout" role="note"><strong>Accepted {p.accepted_at ? shortDate(p.accepted_at) : ""}{accepted ? ` by ${accepted.signer_name}` : ""}.</strong> <p>It's locked, so it always matches what was accepted. Revise to send a new version for the client to accept again.</p></div>
  {:else if !editable && p.status !== "revoked"}
    <div class="callout" role="note"><strong>{p.link_only ? "Published quotes are locked." : "Sent quotes are locked."}</strong> <p>The client sees exactly what you {p.link_only ? "published" : "sent"}. To change the quote itself, press Revise: the client keeps seeing version {p.version} until you send or publish the revision, at the same link. Recipient, Valid until, follow ups and internal notes stay editable now.</p></div>
  {/if}
  {#if p.status === "changes_requested" && lastChange}
    <div class="callout warn" role="note"><strong>{String(lastChange.detail.name ?? "The client")} asked for changes {shortDate(lastChange.at)}.</strong> <p>{String(lastChange.detail.message ?? "")}</p></div>
  {/if}
  {#if p.status === "revoked"}
    <div class="callout warn" role="note"><strong>The link is off.</strong> <p>The client sees "This quote isn't available". Make a new link to turn it back on.</p></div>
  {/if}

  <div class="tabs" role="group" aria-label="Show">
    <button type="button" aria-pressed={tab === "edit"} aria-controls="qp-edit" onclick={() => (tab = "edit")}>Edit</button>
    <button type="button" aria-pressed={tab === "preview"} aria-controls="qp-preview" onclick={() => (tab = "preview")}>Preview</button>
  </div>

  <div class="qd">
    <div class="ed" id="qp-edit" class:hide={tab !== "edit"}>
      <div class="sections" role="tablist" aria-label="Quote sections" tabindex="-1" onkeydown={sectionKeys}>
        {#each SECTIONS as x (x.id)}
          <button type="button" role="tab" id="qt-{x.id}" aria-selected={sec === x.id} aria-controls="qs-{x.id}" tabindex={sec === x.id ? 0 : -1} onclick={() => pickSection(x.id)}>
            {x.id === "rows" && d.content.tiers.length <= 1 ? "What's included" : x.label}
          </button>
        {/each}
      </div>

      <div role="tabpanel" id="qs-client" aria-labelledby="qt-client" hidden={sec !== "client"}>
      <section class="card">
        <div class="card-head"><h2>Client</h2></div>
        <div class="grid">
          <Field id="q-owner" label="For" required wide hint={p.version ? "A sent quote stays with its client. Duplicate it to quote someone else." : ""}>
            {#snippet children(a)}
              <select {...a} class="input" value={d.owner} disabled={p!.version > 0} onchange={(e) => pickOwner(e.currentTarget.value)}>
                <option value="" disabled>Pick a client or lead</option>
                {#if choices.clients.length}<optgroup label="Clients">{#each choices.clients as c (c.value)}<option value={c.value}>{c.label}</option>{/each}</optgroup>{/if}
                {#if choices.leads.length}<optgroup label="Leads">{#each choices.leads as l (l.value)}<option value={l.value}>{l.label}</option>{/each}</optgroup>{/if}
                <option value="new">New lead…</option>
              </select>
            {/snippet}
          </Field>
          {#if newLead}
            <div class="newlead wide">
              <p class="sub">New lead</p>
              <div class="grid3">
                <Field id="nl-name" label="Name" required>{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={newLead!.name} />{/snippet}</Field>
                <Field id="nl-company" label="Company">{#snippet children(a)}<input {...a} class="input" maxlength="160" bind:value={newLead!.company} />{/snippet}</Field>
                <Field id="nl-email" label="Email" required>{#snippet children(a)}<input {...a} class="input" type="email" maxlength="254" bind:value={newLead!.email} />{/snippet}</Field>
              </div>
              <div class="row"><button type="button" class="btn ghost sm" onclick={() => (newLead = null)}>Cancel</button><button type="button" class="btn primary sm" disabled={busy} onclick={createLead}>Add lead</button></div>
            </div>
          {/if}
          <Field id="q-rname" label="Recipient name">{#snippet children(a)}<input {...a} class="input" maxlength="120" autocomplete="off" bind:value={d.recipient_name} />{/snippet}</Field>
          <Field id="q-email" label="Recipient email" required>{#snippet children(a)}<input {...a} class="input" type="email" maxlength="254" autocomplete="off" bind:value={d.recipient_email} />{/snippet}</Field>
          <Field id="q-cc" label="Cc" hint="Optional. Up to 5, separated by commas." wide>{#snippet children(a)}<input {...a} class="input" autocomplete="off" bind:value={d.cc} />{/snippet}</Field>
        </div>
      </section>
      </div>

      <div role="tabpanel" id="qs-details" aria-labelledby="qt-details" hidden={sec !== "details"}>
      <section class="card">
          <div class="card-head"><h2>Details</h2><span class="sub">Placeholders: {PLACEHOLDERS.map((x) => `{${x}}`).join(" ")}</span></div>
          <div class="grid">
            <Field id="q-title" label="Title" required wide hint="The last word gets the lime highlight on the page.">{#snippet children(a)}<input {...a} class="input" maxlength="120" disabled={!editable} bind:value={d.title} />{/snippet}</Field>
            <Field id="q-prepared" label="Prepared">{#snippet children(a)}<input {...a} class="input" type="date" disabled={!editable} bind:value={d.prepared_on} />{/snippet}</Field>
            <Field id="q-valid" label="Valid until" hint={p!.status === "expired" ? "A later date reopens it." : ""}>{#snippet children(a)}<input {...a} class="input" type="date" disabled={p!.status === "accepted" && !p!.revising} bind:value={d.valid_until} />{/snippet}</Field>
            <Field id="q-intro" label="Intro" wide hint="A short paragraph under the title.">{#snippet children(a)}<textarea {...a} class="input" rows="3" maxlength="1500" disabled={!editable} bind:value={d.content.intro}></textarea>{/snippet}</Field>
          </div>
        </section>
      </div>

      <fieldset class="plain" disabled={!editable}>

        <div role="tabpanel" id="qs-tiers" aria-labelledby="qt-tiers" hidden={sec !== "tiers"}>
        <section class="card">
          <div class="card-head"><div><h2>Tiers</h2><p class="sub">{d.content.tiers.length === 1 ? "One tier shows as a simple quote: what's included and the total." : "The client picks one."}</p></div></div>
          <ol class="list">
            {#each d.content.tiers as t, i (t.key)}
              {@const m = doc && hasCosts ? tierMargin(doc, internal, t.key) : null}
              {@const svc = linked("tier", t.key)}
              <li class="item">
                <div class="itemhead">
                  <span class="num muted">{i + 1}</span>
                  <Field id="tier-{t.key}-name" label="Name" required>{#snippet children(a)}<input {...a} class="input" maxlength="60" bind:value={t.name} />{/snippet}</Field>
                  <div class="reorder">
                    <button type="button" class="iconbtn" aria-label="Move {t.name || 'tier'} up" disabled={i === 0} onclick={() => move(d.content.tiers, i, i - 1)}><Icon name="up" /></button>
                    <button type="button" class="iconbtn" aria-label="Move {t.name || 'tier'} down" disabled={i === d.content.tiers.length - 1} onclick={() => move(d.content.tiers, i, i + 1)}><Icon name="down" /></button>
                    <button type="button" class="iconbtn danger" aria-label="Remove {t.name || 'tier'}" disabled={d.content.tiers.length === 1} onclick={() => removeTier(i)}><Icon name="close" /></button>
                  </div>
                </div>
                <div class="grid">
                  <Field id="tier-{t.key}-billing" label="Billing" wide>
                    {#snippet children(a)}
                      <select {...a} class="input" value={billingOf(t)} onchange={(e) => setBilling(t, e.currentTarget.value as TierBilling)}>
                        <option value="once">One time</option>
                        <option value="monthly">Monthly</option>
                        <option value="both">One time plus monthly</option>
                      </select>
                    {/snippet}
                  </Field>
                  {#if billingOf(t) !== "monthly"}
                    {@render money(`tier-${t.key}-price`, "One time price", t, "price")}
                    {@render discount(`tier-${t.key}-disc`, t, "discount", t.price)}
                  {/if}
                  {#if billingOf(t) !== "once"}
                    <Field id="tier-{t.key}-mo" label="Monthly price" required>{#snippet children(a)}<div class="amt"><span aria-hidden="true">$</span><input {...a} type="number" min="0" step="0.01" inputmode="decimal" value={t.monthly ?? ""} oninput={(e) => (t.monthly = e.currentTarget.value === "" ? 0 : e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
                    {@render discount(`tier-${t.key}-mdisc`, t, "monthly_discount", t.monthly)}
                  {/if}
                  <Field id="tier-{t.key}-sum" label="One line summary" wide>{#snippet children(a)}<input {...a} class="input" maxlength="240" bind:value={t.summary} />{/snippet}</Field>
                </div>
                <div class="flags">
                  <label class="check"><input type="radio" name="rec" checked={d.content.recommended === t.key} onchange={() => (d.content.recommended = t.key)} /> Recommended</label>
                  <label class="check"><input type="radio" name="def" checked={d.content.default_tier === t.key} onchange={() => (d.content.default_tier = t.key)} /> Selected when the page opens</label>
                  {#if d.content.recommended === t.key}<button type="button" class="linkbtn" onclick={() => (d.content.recommended = null)}>No recommended tier</button>{/if}
                </div>
                <div class="internal">
                  <Field id="tier-{t.key}-cost" label="Your cost (internal)">{#snippet children(a)}<div class="amt"><span aria-hidden="true">$</span><input {...a} type="number" min="0" step="0.01" inputmode="decimal" value={d.costs[`tier:${t.key}`] ?? ""} oninput={(e) => (d.costs[`tier:${t.key}`] = e.currentTarget.value === "" ? null : e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
                  {#if m}<p class="margin" class:neg={m.margin < 0}>Margin {usd(m.margin)}{m.pct !== null ? ` (${Math.round(m.pct * 100)}%)` : ""} <span class="muted">on {usd(m.revenue)}, costs {usd(m.cost)} incl. its rows</span></p>{/if}
                  {#if svc}
                    <p class="muted cat">From the catalog: {svc.name}, {unitPrice(svc)}.
                      {#if svc.price !== t.price}<button type="button" class="linkbtn" onclick={() => updateCatalogPrice(svc, t.price)}>Update catalog price to {usd(cents(t.price))}</button>{/if}</p>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
          <div class="adds">
            <button type="button" class="btn sm" disabled={d.content.tiers.length >= 6} onclick={() => addTier()}><Icon name="plus" size={14} /> Add tier</button>
            <button type="button" class="btn sm ghost" disabled={d.content.tiers.length >= 6} onclick={() => (picking = picking === "tier" ? "" : "tier")}>From the catalog</button>
          </div>
          {#if picking === "tier"}{@render picker()}{/if}
        </section>
        </div>

        <div role="tabpanel" id="qs-rows" aria-labelledby="qt-rows" hidden={sec !== "rows"}>
        <section class="card">
          <div class="card-head">
            <div><h2>{d.content.tiers.length > 1 ? "Comparison rows" : "What's included"}</h2><p class="sub">Tick the tiers each item is in. Text shows instead of a check, like "1 week".</p></div>
            {#if d.content.rows.length}<button type="button" class="btn ghost sm" onclick={() => { const all = d.content.rows.every((r) => openRows[r.key]); for (const r of d.content.rows) openRows[r.key] = !all; }}>{d.content.rows.every((r) => openRows[r.key]) ? "Collapse all" : "Expand all"}</button>{/if}
          </div>
          <ol class="list rows" bind:this={rowsEl}>
            {#each d.content.rows as r, i (r.key)}
              <li class="item row" data-row={r.key}>
                <div class="rowhead">
                  <button type="button" class="grip" data-grip={r.key} aria-label="Reorder {r.label || 'row'}. Drag, or use the up and down arrow keys." title="Drag to reorder" onpointerdown={(e) => startRowDrag(e, r.key)} onkeydown={(e) => rowKey(e, i, r.key)}><Icon name="grip" /></button>
                  <button type="button" class="rowtoggle" aria-expanded={!!openRows[r.key]} aria-controls="row-{r.key}-body" onclick={() => (openRows[r.key] = !openRows[r.key])}>
                    <span class="rlabel">{r.label || "New row"}</span>
                    <span class="marks" aria-hidden="true">{#each d.content.tiers as t (t.key)}<span class:on={isOn(r.values[t.key])}>{isOn(r.values[t.key]) ? (cellText(r.values[t.key]) ? "T" : "✓") : "·"}</span>{/each}</span>
                    <Icon name={openRows[r.key] ? "up" : "down"} />
                  </button>
                  <Menu label="More for {r.label || 'this row'}" items={[
                    { label: "Duplicate", onselect: () => duplicateRow(i) },
                    { label: "Move up", disabled: i === 0, onselect: () => move(d.content.rows, i, i - 1) },
                    { label: "Move down", disabled: i === d.content.rows.length - 1, onselect: () => move(d.content.rows, i, i + 1) },
                    { label: "Delete", danger: true, onselect: () => d.content.rows.splice(i, 1) },
                  ]} />
                </div>
                <div class="rowbody" id="row-{r.key}-body" hidden={!openRows[r.key]}>
                  <Field id="row-{r.key}-label" label="Label" required>{#snippet children(a)}<input {...a} class="input" maxlength="120" bind:value={r.label} />{/snippet}</Field>
                  <fieldset class="cells">
                    <legend>Included in</legend>
                    {#each d.content.tiers as t (t.key)}
                      <div class="cell">
                        <label class="check"><input type="checkbox" checked={isOn(r.values[t.key])} onchange={(e) => setCell(r, t.key, e.currentTarget.checked)} /> {t.name || "Tier"}</label>
                        <input class="input sm" aria-label="Text for {t.name || 'this tier'} instead of a check" placeholder="✓" maxlength="60" disabled={!isOn(r.values[t.key])} value={cellText(r.values[t.key])} oninput={(e) => setCellText(r, t.key, e.currentTarget.value)} />
                      </div>
                    {/each}
                  </fieldset>
                  <Field id="row-{r.key}-explain" label="Explanation" hint="What the client sees when they tap the row.">{#snippet children(a)}<textarea {...a} class="input" rows="2" maxlength="1200" bind:value={r.explain}></textarea>{/snippet}</Field>
                  <Field id="row-{r.key}-cost" label="Your cost (internal)" hint="Counts toward the margin of every tier it's in.">{#snippet children(a)}<div class="amt"><span aria-hidden="true">$</span><input {...a} type="number" min="0" step="0.01" inputmode="decimal" value={d.costs[`row:${r.key}`] ?? ""} oninput={(e) => (d.costs[`row:${r.key}`] = e.currentTarget.value === "" ? null : e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
                </div>
              </li>
            {:else}
              <li class="none muted">No rows yet. Add what's included, from scratch or from the catalog.</li>
            {/each}
          </ol>
          <div class="adds">
            <button type="button" class="btn sm" disabled={d.content.rows.length >= 80} onclick={() => addRow()}><Icon name="plus" size={14} /> Add row</button>
            <button type="button" class="btn sm ghost" disabled={d.content.rows.length >= 80} onclick={() => (picking = picking === "row" ? "" : "row")}>From the catalog</button>
          </div>
          {#if picking === "row"}{@render picker()}{/if}
        </section>
        </div>

        <div role="tabpanel" id="qs-addons" aria-labelledby="qt-addons" hidden={sec !== "addons"}>
        <section class="card">
          <div class="card-head"><div><h2>Add ons</h2><p class="sub">Extras the client can tick. Per tier: can add, already included, or not offered.</p></div></div>
          <ol class="list">
            {#each d.content.addons as a, i (a.key)}
              {@const svc = linked("addon", a.key)}
              <li class="item">
                <div class="itemhead">
                  <Field id="addon-{a.key}-name" label="Name" required>{#snippet children(x)}<input {...x} class="input" maxlength="120" bind:value={a.name} />{/snippet}</Field>
                  <div class="reorder">
                    <button type="button" class="iconbtn" aria-label="Move {a.name || 'add on'} up" disabled={i === 0} onclick={() => move(d.content.addons, i, i - 1)}><Icon name="up" /></button>
                    <button type="button" class="iconbtn" aria-label="Move {a.name || 'add on'} down" disabled={i === d.content.addons.length - 1} onclick={() => move(d.content.addons, i, i + 1)}><Icon name="down" /></button>
                    <button type="button" class="iconbtn danger" aria-label="Remove {a.name || 'add on'}" onclick={() => d.content.addons.splice(i, 1)}><Icon name="close" /></button>
                  </div>
                </div>
                <div class="grid">
                  {@render money(`addon-${a.key}-price`, "Price", a, "price")}
                  <Field id="addon-{a.key}-billing" label="Billing">{#snippet children(x)}<select {...x} class="input" bind:value={a.billing}><option value="once">One time</option><option value="monthly">Monthly</option></select>{/snippet}</Field>
                  {@render discount(`addon-${a.key}-disc`, a, "discount", a.price)}
                  <Field id="addon-{a.key}-cost" label="Your cost (internal)">{#snippet children(x)}<div class="amt"><span aria-hidden="true">$</span><input {...x} type="number" min="0" step="0.01" inputmode="decimal" value={d.costs[`addon:${a.key}`] ?? ""} oninput={(e) => (d.costs[`addon:${a.key}`] = e.currentTarget.value === "" ? null : e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
                  <Field id="addon-{a.key}-desc" label="Description" wide>{#snippet children(x)}<textarea {...x} class="input" rows="2" maxlength="500" bind:value={a.description}></textarea>{/snippet}</Field>
                </div>
                <fieldset class="cells">
                  <legend>On each tier</legend>
                  {#each d.content.tiers as t (t.key)}
                    <label class="cellsel"><span>{t.name || "Tier"}</span>
                      <select class="input sm" value={a.tiers[t.key] ?? "available"} onchange={(e) => (a.tiers[t.key] = e.currentTarget.value as Addon["tiers"][string])}>
                        <option value="available">Can add</option><option value="included">Included</option><option value="unavailable">Not offered</option>
                      </select>
                    </label>
                  {/each}
                </fieldset>
                {#if svc}
                  <p class="muted cat">From the catalog: {svc.name}, {unitPrice(svc)}.
                    {#if svc.price !== a.price}<button type="button" class="linkbtn" onclick={() => updateCatalogPrice(svc, a.price)}>Update catalog price to {usd(cents(a.price))}</button>{/if}</p>
                {/if}
              </li>
            {:else}
              <li class="none muted">No add ons.</li>
            {/each}
          </ol>
          <div class="adds">
            <button type="button" class="btn sm" disabled={d.content.addons.length >= 30} onclick={() => addAddon()}><Icon name="plus" size={14} /> Add add on</button>
            <button type="button" class="btn sm ghost" disabled={d.content.addons.length >= 30} onclick={() => (picking = picking === "addon" ? "" : "addon")}>From the catalog</button>
          </div>
          {#if picking === "addon"}{@render picker()}{/if}
        </section>
        </div>

        <div role="tabpanel" id="qs-pricing" aria-labelledby="qt-pricing" hidden={sec !== "pricing"}>
        <section class="card">
          <div class="card-head"><h2>Pricing and payment</h2></div>
          <label class="check"><input type="checkbox" checked={!!d.content.discount} onchange={(e) => (d.content.discount = e.currentTarget.checked ? { kind: "percent", value: 10, label: "Discount", applies_to: "once" } : null)} /> Discount the total</label>
          {#if d.content.discount}
            {@const w = d.content.discount}
            <div class="grid4">
              <Field id="q-dlabel" label="Label">{#snippet children(a)}<input {...a} class="input" maxlength="60" bind:value={w.label} />{/snippet}</Field>
              <Field id="q-dkind" label="Type">{#snippet children(a)}<select {...a} class="input" bind:value={w.kind}><option value="percent">Percent</option><option value="amount">Amount</option></select>{/snippet}</Field>
              <Field id="q-dval" label={w.kind === "percent" ? "Percent off" : "Amount off"}>{#snippet children(a)}<div class="amt"><span aria-hidden="true">{w.kind === "percent" ? "%" : "$"}</span><input {...a} type="number" min="0" step="0.01" max={w.kind === "percent" ? 100 : undefined} value={w.value} oninput={(e) => (w.value = e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
              <Field id="q-dapp" label="Applies to">{#snippet children(a)}<select {...a} class="input" bind:value={w.applies_to}><option value="once">One time total</option><option value="monthly">Monthly total</option></select>{/snippet}</Field>
            </div>
          {/if}
          <div class="pay">
            <Field id="q-pay" label="Payment at acceptance" hint={settings?.stripe_mode === "off" ? "Stripe isn't connected yet, so the client sees \"We'll send you an invoice\"." : `Stripe is connected (${settings?.stripe_mode} mode): the client can pay by card right after accepting.`}>
              {#snippet children(a)}<select {...a} class="input" bind:value={d.content.payment.mode}><option value="none">None</option><option value="deposit">Deposit</option><option value="full">Full payment</option></select>{/snippet}
            </Field>
            {#if d.content.payment.mode === "deposit"}
              <Field id="q-dep" label="Deposit">{#snippet children(a)}<div class="amt"><span aria-hidden="true">{d.content.payment.deposit_kind === "percent" ? "%" : "$"}</span><input {...a} type="number" min="0" step="0.01" value={d.content.payment.deposit_value} oninput={(e) => (d.content.payment.deposit_value = e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
              <Field id="q-depk" label="Of the one time total">{#snippet children(a)}<select {...a} class="input" bind:value={d.content.payment.deposit_kind}><option value="percent">Percent</option><option value="amount">Fixed amount</option></select>{/snippet}</Field>
            {/if}
          </div>
          {#if doc}
            {@const t = totals(doc, doc.default_tier, [])}
            <p class="muted sum">With {tierName(doc.default_tier, doc)} selected: {t.once_total || !t.monthly_total ? `one time ${usd(t.once_total)}` : ""}{t.once_total && t.monthly_total ? ", " : ""}{t.monthly_total ? `monthly ${usd(t.monthly_total)}` : ""}{t.savings_once + t.savings_monthly ? `, saving ${usd(t.savings_once)}` : ""}{t.due_now ? `, ${usd(t.due_now)} due at acceptance` : ""}.</p>
          {/if}
        </section>
        </div>

        <div role="tabpanel" id="qs-fine" aria-labelledby="qt-fine" hidden={sec !== "fine"}>
        <section class="card">
          <div class="card-head"><div><h2>Fine print</h2><p class="sub">Notes under the total. Each can show for some tiers, or only when an add on is chosen.</p></div></div>
          <ol class="list">
            {#each d.content.fine_print as f, i (f.key)}
              <li class="item">
                <div class="itemhead">
                  <Field id="fine-{f.key}" label="Note" required>{#snippet children(a)}<input {...a} class="input" maxlength="400" bind:value={f.text} />{/snippet}</Field>
                  <div class="reorder"><button type="button" class="iconbtn danger" aria-label="Remove this note" onclick={() => d.content.fine_print.splice(i, 1)}><Icon name="close" /></button></div>
                </div>
                <div class="flags">
                  <span class="muted small">Show for</span>
                  {#each d.content.tiers as t (t.key)}
                    <label class="check"><input type="checkbox" checked={!f.tiers.length || f.tiers.includes(t.key)} onchange={(e) => {
                      const all = d.content.tiers.map((x) => x.key);
                      const cur = f.tiers.length ? [...f.tiers] : all;
                      const next = e.currentTarget.checked ? [...new Set([...cur, t.key])] : cur.filter((k) => k !== t.key);
                      f.tiers = next.length === all.length ? [] : next;
                    }} /> {t.name || "Tier"}</label>
                  {/each}
                  {#if d.content.addons.length}
                    <label class="cellsel"><span>Only with</span>
                      <select class="input sm" value={f.addon ?? ""} onchange={(e) => (f.addon = e.currentTarget.value || null)}>
                        <option value="">Any selection</option>
                        {#each d.content.addons as a (a.key)}<option value={a.key}>{a.name || "Add on"}</option>{/each}
                      </select>
                    </label>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
          <div class="adds"><button type="button" class="btn sm" disabled={d.content.fine_print.length >= 12} onclick={addFine}><Icon name="plus" size={14} /> Add note</button></div>
          <label class="check"><input type="checkbox" bind:checked={d.content.terms} /> Link to the Terms and Conditions (cyberx.la/terms)</label>
        </section>
        </div>
      </fieldset>

      <div role="tabpanel" id="qs-notes" aria-labelledby="qt-notes" hidden={sec !== "notes"}>
      <section class="card">
        <div class="card-head"><h2>Follow ups</h2></div>
        <label class="check"><input type="checkbox" bind:checked={d.reminders} /> Remind the client automatically</label>
        <p class="muted small">One email if they haven't opened it {settings?.remind_unviewed_days ?? 3} days after sending, and one {settings?.remind_expiry_days ?? 2} days before it expires. Weekdays and weekends, 9 AM to 5 PM Pacific. Change the days in Quotes, Settings.</p>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Internal notes</h2><p class="sub">Only you see these. Never on the client's page.</p></div></div>
        <textarea class="input" rows="3" maxlength="5000" aria-label="Internal notes" bind:value={d.internal_notes}></textarea>
      </section>
      </div>

      <div role="tabpanel" id="qs-history" aria-labelledby="qt-history" hidden={sec !== "history"}>
      {#if accepted}
        <section class="card">
          <div class="card-head"><h2>Acceptance</h2><span class="sub">Version {accepted.version}, {dateTime(accepted.accepted_at)}</span></div>
          <dl class="factlist">
            <div><dt>Signed by</dt><dd>{accepted.signer_name}{accepted.signer_title ? `, ${accepted.signer_title}` : ""} ({accepted.signer_email})</dd></div>
            <div><dt>Signature</dt><dd class="sig">{accepted.signature}</dd></div>
            <div><dt>Selection</dt><dd>{selectionText(accepted.doc, accepted.tier, accepted.addons)}</dd></div>
            <div><dt>One time</dt><dd>{usd(Math.round(accepted.once_total * 100))}</dd></div>
            {#if accepted.monthly_total}<div><dt>Monthly</dt><dd>{usd(Math.round(accepted.monthly_total * 100))}/mo</dd></div>{/if}
            {#if accepted.due_now}<div><dt>Due at acceptance</dt><dd>{usd(Math.round(accepted.due_now * 100))}{paid ? `, ${usd(Math.round(paid * 100))} paid` : ", not paid yet"}</dd></div>{/if}
            {#if project}<div><dt>Project</dt><dd><a href="#/projects/{project.id}">{project.name}</a></dd></div>{/if}
          </dl>
        </section>
      {/if}

      {#if payments.length}
        <section class="card">
          <div class="card-head"><h2>Payments</h2></div>
          <ul class="tl">
            {#each payments as m (m.id)}<li><span>{m.kind === "full" ? "Full payment" : m.kind === "deposit" ? "Deposit" : m.kind} {usd(Math.round(m.amount * 100))}{m.livemode ? "" : " (test)"}</span><span class="muted">{m.status}{m.paid_at ? `, ${dateTime(m.paid_at)}` : ""}</span></li>{/each}
          </ul>
        </section>
      {/if}

      <section class="card">
        <div class="card-head"><h2>Timeline</h2></div>
        <ol class="tl">
          {#each events as e (e.id)}<li><span>{describeEvent(e)}</span><span class="muted">{dateTime(e.at)}</span></li>{:else}<li class="muted">Nothing yet.</li>{/each}
        </ol>
      </section>

      {#if versions.length}
        <section class="card">
          <div class="card-head"><div><h2>Versions</h2><p class="sub">What the client saw each time. The latest is what they see now.</p></div></div>
          <ol class="tl">
            {#each versions as v (v.id)}
              <li><span>Version {v.version}{v.version === p.version ? " (current)" : ""}, sent {dateTime(v.sent_at)}</span>
                <button type="button" class="linkbtn" aria-pressed={versionShown?.id === v.id} onclick={() => { versionShown = versionShown?.id === v.id ? null : v; tab = "preview"; }}>{versionShown?.id === v.id ? "Back to the draft" : "Show in preview"}</button></li>
            {/each}
          </ol>
        </section>
      {/if}
      </div>
    </div>

    <aside class="pvcol" id="qp-preview" aria-label="Preview" class:hide={tab !== "preview"}>
      {#if versionShown}<p class="callout">Showing version {versionShown.version} as it was sent. <button class="linkbtn" onclick={() => (versionShown = null)}>Back to the draft</button></p>{/if}
      <QuotePreview {model} label="Preview of {quoteNo(p)}" />
    </aside>
  </div>

  {#if settings}
    <SendDialog open={sending !== ""} mode={sending === "resend" ? "resend" : "send"} proposal={p} company={vars?.company ?? ""} firstName={vars?.contact_first_name ?? "there"} title={titleFilled}
      {settings} {emailReady} onclose={() => (sending = "")} onsend={doSend} onschedule={doSchedule} ontest={doTest} onpublish={doPublish} />
  {/if}

  <Modal open={converting} title="Convert {quoteNo(p)} to a project" onclose={() => (converting = false)}>
    <div class="conv">
      {#if accepted}
        <p>The project gets what was accepted on {shortDate(accepted.accepted_at)}: <strong>{selectionText(accepted.doc, accepted.tier, accepted.addons)}</strong>, at the accepted prices, with the included items as a checklist in its notes.</p>
      {:else if lastVersion}
        {@const av = addonsFor(lastVersion.content, conv.tier).available}
        <p class="muted">This quote wasn't accepted online. Pick what the project covers.</p>
        <Field id="cv-tier" label="Tier">{#snippet children(a)}<select {...a} class="input" bind:value={conv.tier}>{#each lastVersion!.content.tiers as t (t.key)}<option value={t.key}>{t.name}</option>{/each}</select>{/snippet}</Field>
        {#if av.length}
          <fieldset class="cells"><legend>Add ons</legend>
            {#each av as a (a.key)}<label class="check"><input type="checkbox" checked={conv.addons.includes(a.key)} onchange={(e) => (conv.addons = e.currentTarget.checked ? [...conv.addons, a.key] : conv.addons.filter((k) => k !== a.key))} /> {a.name}</label>{/each}
          </fieldset>
        {/if}
      {/if}
      {#if convPlan}
        <ul class="tl">
          {#each convPlan.lines as l (l.key)}<li><span>{l.name}</span><span>{usd(l.net)}{l.billing === "monthly" ? "/mo" : ""}</span></li>{/each}
          <li><strong>One time</strong><strong>{usd(convPlan.once)}</strong></li>
          {#if convPlan.monthly}<li><strong>Monthly</strong><strong>{usd(convPlan.monthly)}/mo</strong></li>{/if}
        </ul>
      {/if}
      {#if p.lead_id}
        <label class="check"><input type="checkbox" bind:checked={conv.lead} /> Also convert {owner?.label ?? "the lead"} to a client (the usual convert: contact details, its quote request's services, and its projects and quotes move over)</label>
      {/if}
      <div class="row"><button type="button" class="btn ghost" onclick={() => (converting = false)}>Cancel</button><button type="button" class="btn primary" disabled={busy || !convPlan} onclick={doConvert}>Create project</button></div>
    </div>
  </Modal>

  <Modal open={templating} title="Save as a template" onclose={() => (templating = false)}>
    <form class="conv" onsubmit={saveTemplate}>
      <Field id="tpl-name" label="Template name" required hint="Templates keep tiers, rows, add ons, prices, fine print and internal costs. Write client details as placeholders.">{#snippet children(a)}<input {...a} class="input" maxlength="80" bind:value={templateName} />{/snippet}</Field>
      <div class="row"><button type="button" class="btn ghost" onclick={() => (templating = false)}>Cancel</button><button class="btn primary" disabled={!templateName.trim()}>Save template</button></div>
    </form>
  </Modal>
{/if}

<Confirm bind:this={confirm} />

{#snippet money(fid: string, label: string, obj: { price: number }, key: "price")}
  <Field id={fid} label={label} required>{#snippet children(a)}<div class="amt"><span aria-hidden="true">$</span><input {...a} type="number" min="0" step="0.01" inputmode="decimal" value={obj[key]} oninput={(e) => (obj[key] = e.currentTarget.valueAsNumber)} /></div>{/snippet}</Field>
{/snippet}

{#snippet discount(fid: string, obj: Tier | Addon, field: "discount" | "monthly_discount", base: number | null)}
  {@const dd = (obj as Record<string, unknown>)[field] as Tier["discount"]}
  <div class="disc">
    <label class="check"><input type="checkbox" checked={!!dd} onchange={(e) => toggleDiscount(obj as Tier, field, e.currentTarget.checked)} /> {field === "monthly_discount" ? "Discount monthly" : "Discount"}</label>
    {#if dd}
      <div class="discin">
        <select class="input sm" aria-label="Discount type" value={dd.kind} onchange={(e) => (dd.kind = e.currentTarget.value as "percent" | "amount")}><option value="percent">%</option><option value="amount">$</option></select>
        <input id={fid} class="input sm" type="number" min="0" step="0.01" aria-label="Discount amount" value={dd.value} oninput={(e) => (dd.value = e.currentTarget.valueAsNumber)} />
        {#if base}<span class="muted small">{usd(cents(base))} → {usd(cents(base) - Math.min(cents(base), dd.kind === "percent" ? Math.round((cents(base) * Math.min(100, dd.value || 0)) / 100) : cents(dd.value || 0)))}</span>{/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet picker()}
  <div class="picker">
    <div class="phead">
      <input class="input" type="search" placeholder="Search services" aria-label="Search services" bind:value={search} />
      <button type="button" class="btn ghost sm" onclick={() => { picking = ""; search = ""; }}>Done</button>
    </div>
    {#each pickList as cat (cat.name)}
      <p class="eyebrow catname">{cat.name}</p>
      <ul class="options">
        {#each cat.items as s (s.id)}
          <li><button type="button" onclick={() => pick(s)}><span>{s.name}</span><span class="muted num">{unitPrice(s)}</span><span class="plus" aria-hidden="true">+</span></button></li>
        {/each}
      </ul>
    {:else}
      <p class="muted none">No matching services.</p>
    {/each}
  </div>
{/snippet}

<style>
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .titles { min-width: 0; }
  h1 { font-size: var(--fs-2xl); letter-spacing: -0.035em; line-height: 1.1; margin: 4px 0 10px; overflow-wrap: anywhere; }
  .state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: var(--fs-md); }
  .owner { color: var(--lime); text-decoration: none; font-size: var(--fs-sm); }
  .owner:hover { text-decoration: underline; }
  .tag { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--warning); }
  .acts { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .saved { font-size: var(--fs-sm); color: var(--muted); margin-right: 4px; max-width: 360px; }
  .saved.bad { color: var(--warning); }
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); font-weight: 600; color: var(--text); white-space: nowrap; }
  .pill i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .st-draft i, .st-revoked i, .st-declined i, .st-expired i { background: var(--st-lost); }
  .st-scheduled i { background: var(--st-contacted); }
  .st-sent i, .st-viewed i { background: var(--st-proposal); }
  .st-changes_requested i { background: var(--warning); }
  .st-accepted i { background: var(--st-won); }
  .callout strong { font-weight: 600; }
  .tabs { display: none; }
  .qd { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 46%); gap: 16px; align-items: start; }
  .ed { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .pvcol { position: sticky; top: 16px; height: calc(100dvh - 32px); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  fieldset.plain { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head { margin-bottom: 0; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .grid4 { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1.2fr; gap: 10px; }
  .grid :global(.wide), .wide { grid-column: 1 / -1; }
  .ed :global(.input) { width: 100%; min-width: 0; }
  .input.sm { height: var(--control-sm); padding: 0 10px; font-size: var(--fs-sm); }
  select.input.sm { padding-right: 30px; background-position: right 10px center; }
  .newlead { border: 1px dashed var(--line-2); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .newlead .sub { font-size: var(--fs-sm); font-weight: 600; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .item { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--ink); }
  .itemhead { display: flex; gap: 10px; align-items: flex-end; }
  .itemhead > :global(.field) { flex: 1; }
  .num { width: 18px; padding-bottom: 12px; font-size: var(--fs-sm); }
  .reorder { display: flex; gap: 2px; padding-bottom: 6px; }
  .flags { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-2); }
  .internal { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; border-top: 1px solid var(--line); padding-top: 10px; }
  .internal :global(.field) { width: 160px; }
  .margin { font-size: var(--fs-sm); font-weight: 600; color: var(--good-text); padding-bottom: 10px; }
  .margin.neg { color: var(--critical); }
  .margin .muted { font-weight: 400; }
  .cat { font-size: var(--fs-xs); width: 100%; }
  .amt { display: flex; align-items: center; gap: 6px; height: var(--control-lg); padding: 0 12px; border: 1px solid var(--line-2); border-radius: var(--radius-md); background: var(--ink); }
  .amt:focus-within { border-color: var(--lime); box-shadow: 0 0 0 1px var(--lime); }
  .amt span { color: var(--muted); }
  .amt input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; outline: none; font-weight: 600; -moz-appearance: textfield; appearance: textfield; }
  .amt input::-webkit-inner-spin-button, .amt input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .disc { display: flex; flex-direction: column; gap: 6px; justify-content: flex-end; }
  .discin { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .discin select { width: 64px; }
  .discin input { width: 96px; }
  .adds { display: flex; gap: 8px; flex-wrap: wrap; }
  .rowhead { display: flex; align-items: center; gap: 6px; }
  .rowtoggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 6px 4px; text-align: left; color: var(--text); font-weight: 600; border-radius: var(--radius-sm); }
  .rowtoggle:hover { background: var(--surface-2); }
  .rlabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .marks { display: inline-flex; gap: 4px; font-size: var(--fs-xs); color: var(--muted); }
  .marks span { width: 18px; text-align: center; }
  .marks .on { color: var(--lime); }
  .rowbody { display: flex; flex-direction: column; gap: 10px; padding: 4px 4px 2px 32px; }
  .rowbody[hidden] { display: none; }
  .rowbody :global(.field:last-child) { max-width: 200px; }
  fieldset.cells { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px 14px; min-width: 0; }
  fieldset.cells legend { font-size: var(--fs-sm); font-weight: 500; color: var(--text-2); margin-bottom: 6px; padding: 0; }
  .cell { display: flex; flex-direction: column; gap: 4px; width: 150px; }
  .cellsel { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--text-2); }
  .cellsel select { width: auto; }
  .none { padding: 8px 2px; font-size: var(--fs-sm); }
  .pay { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
  .pay :global(.field) { width: 200px; }
  .pay :global(.field:first-child) { flex: 1 1 280px; width: auto; }
  .sum { font-size: var(--fs-sm); }
  .small { font-size: var(--fs-sm); }
  .tl { list-style: none; display: flex; flex-direction: column; }
  .tl li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
  .tl li:first-child { border-top: 0; }
  .tl li > span:first-child { overflow-wrap: anywhere; }
  .tl li > span:last-child, .tl li > button { flex: none; }
  .sig { font-family: "Brush Script MT", "Segoe Script", cursive; font-size: var(--fs-lg); }
  .conv { display: flex; flex-direction: column; gap: 14px; }
  .conv :global(.input) { width: 100%; }
  .hide { display: flex; }
  @media (max-width: 1100px) {
    .tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
    .tabs button { flex: 1; padding: 8px 14px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-2); font-weight: 600; font-size: var(--fs-md); }
    .tabs button[aria-pressed="true"] { color: var(--ink); background: var(--lime); }
    .qd { grid-template-columns: minmax(0, 1fr); }
    .hide { display: none; }
    .pvcol { position: static; height: calc(100dvh - 120px); }
  }
  @media (max-width: 640px) {
    h1 { font-size: var(--fs-xl); }
    .grid, .grid3, .grid4 { grid-template-columns: 1fr; }
    .rowbody { padding-left: 0; }
    .cell { width: calc(50% - 7px); }
    .saved { width: 100%; }
  }
  .sections { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
  .sections button { min-height: 36px; padding: 0 14px; border-radius: var(--radius-pill); border: 1px solid var(--line-2); background: transparent; color: var(--text-2); font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
  .sections button:hover { color: var(--text); background: var(--surface-2); }
  .sections button[aria-selected="true"] { background: var(--lime); border-color: var(--lime); color: var(--on-lime); }
  [role="tabpanel"] { display: flex; flex-direction: column; gap: var(--gap, 16px); }
  [role="tabpanel"][hidden] { display: none; }
</style>
