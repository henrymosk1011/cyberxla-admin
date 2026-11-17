<script lang="ts">
  import Icon from "./components/Icon.svelte";
  import db from "$db";
  import Login from "./pages/Login.svelte";
  import Overview from "./pages/Overview.svelte";
  import Leads from "./pages/Leads.svelte";
  import LeadDetail from "./pages/LeadDetail.svelte";
  import Clients from "./pages/Clients.svelte";
  import ClientDetail from "./pages/ClientDetail.svelte";
  import Projects from "./pages/Projects.svelte";
  import ProjectDetail from "./pages/ProjectDetail.svelte";
  import Services from "./pages/Services.svelte";
  import Quotes from "./pages/Quotes.svelte";
  import { catalog } from "./lib/store.svelte.ts";
  import { lock } from "./lib/vault.svelte.ts";
  import Toast from "./components/Toast.svelte";
  import Brand from "./components/Brand.svelte";
  import Skeleton from "./components/Skeleton.svelte";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { watchIdle } from "./lib/idle.ts";
  import { money } from "./lib/format.ts";
  import { arrival, leave, pageHeading } from "./lib/nav.svelte.ts";
  import { ms } from "./lib/motion.ts";
  import { messageOf, toast } from "./lib/toast.svelte.ts";
  import type { AuthState, Client, ClientService, Lead, LeadStatus, Project, ProjectService, ProposalRow, Quote } from "./lib/types.ts";

  const IDLE_MS = 30 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let auth = $state<AuthState | null>(null);
  let leads = $state<Lead[]>([]);
  let quotes = $state<Quote[]>([]);
  let clients = $state<Client[]>([]);
  let clientLines = $state<ClientService[]>([]);
  let projects = $state<Project[]>([]);
  let projectLines = $state<ProjectService[]>([]);
  let proposals = $state<ProposalRow[]>([]);
  let loaded = $state(false);
  let stale = $state(false);
  let loadError = $state("");
  let version = $state(0);
  let live = $state(false);
  let unseen = $state(0);
  let hash = $state(location.hash);
  let navOpen = $state(false);

  const route = $derived.by(() => {
    const full = hash.replace(/^#/, "") || "/";
    const h = full.split("?")[0]!;
    const query = new URLSearchParams(full.split("?")[1] ?? "");
    if (h === "/quotes") return { page: "quotes" as const };
    if (h === "/quotes/templates") return { page: "quote-templates" as const };
    if (h === "/quotes/settings") return { page: "quote-settings" as const };
    if (h === "/quotes/payments") return { page: "payments" as const };
    const qd = h.match(/^\/quotes\/([^/]+)$/);
    if (qd) return UUID.test(qd[1]!) ? { page: "quote" as const, id: qd[1]!, send: query.get("send") === "1" } : { page: "notfound" as const };
    const m = h.match(/^\/leads\/([^/]+)$/);
    if (m) return UUID.test(m[1]!) ? { page: "lead" as const, id: m[1]! } : { page: "notfound" as const };
    if (h === "/leads") return { page: "leads" as const };
    if (h === "/board") return { page: "board" as const };
    if (h === "/clients") return { page: "clients" as const };
    if (h === "/services") return { page: "services" as const };
    if (h === "/projects") return { page: "projects" as const };
    if (h === "/reports") return { page: "reports" as const };
    if (h === "/reports/settings") return { page: "report-settings" as const };
    if (h === "/reports/template") return { page: "report-template" as const };
    const r = h.match(/^\/reports\/([^/]+)$/);
    if (r) return UUID.test(r[1]!) ? { page: "report" as const, id: r[1]! } : { page: "notfound" as const };
    const c = h.match(/^\/clients\/([^/]+)$/);
    if (c) return UUID.test(c[1]!) ? { page: "client" as const, id: c[1]! } : { page: "notfound" as const };
    const p = h.match(/^\/projects\/([^/]+)$/);
    if (p) return UUID.test(p[1]!) ? { page: "project" as const, id: p[1]! } : { page: "notfound" as const };
    if (h === "/") return { page: "overview" as const };
    return { page: "notfound" as const };
  });
  // Archived leads and quotes stay out of the pipeline, board, and stats.
  const activeLeads = $derived(leads.filter((l) => !l.archived_at));
  const activeQuotes = $derived.by(() => {
    const ids = new Set(activeLeads.map((l) => l.id));
    return quotes.filter((q) => !q.archived_at && ids.has(q.lead_id));
  });
  const newCount = $derived(activeLeads.filter((l) => l.status === "new").length);

  $effect(() => {
    // Every history entry carries a number, so a leave that is turned down can
    // go back exactly the way it came (a link, a button, or Back and Forward).
    const step = () => (history.state as { i?: number } | null)?.i;
    let at = step() ?? 0;
    if (step() === undefined) history.replaceState({ i: at }, "");
    let asking = false;
    const onHash = async () => {
      if (location.hash === hash) return;
      // A new entry has no number yet; Back and Forward land on one that has.
      if (step() === undefined) history.replaceState({ i: at + 1 }, "");
      // A page with unsaved edits gets to ask first.
      const guard = leave.guard;
      if (guard) {
        if (asking) return;
        asking = true;
        const ok = await guard();
        asking = false;
        if (!ok) {
          history.go(at - (step() ?? at));
          return;
        }
        leave.guard = null;
      }
      at = step() ?? at;
      // The new page's heading takes focus. Switching between the leads list
      // and board is the same page, so focus stays on the switch.
      const from = route.page;
      hash = location.hash; navOpen = false; window.scrollTo(0, 0);
      const sameLeadsPage = ["leads", "board"].includes(from) && ["leads", "board"].includes(route.page);
      arrival.pending = !sameLeadsPage;
      // Lists are cheap to reload; keeps clients and totals current after edits on detail pages.
      if (auth?.step === "ready" && loaded) refresh();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  db.onSignedOut(() => {
    lock();
    auth = { step: "signed-out" };
    leads = []; quotes = []; projects = []; projectLines = []; loaded = false;
  });
  db.authState().then((s) => (auth = s), () => (auth = { step: "signed-out" }));

  async function refresh() {
    stale = true;
    try {
      [leads, quotes, clients, clientLines, projects, projectLines, catalog.categories, catalog.services, proposals] = await Promise.all([
        db.leads(), db.quotes(), db.clients(), db.allClientServices(), db.projects(), db.allProjectServices(), db.categories(), db.services(), db.proposals(),
      ]);
      loaded = true;
      loadError = "";
      version++;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't load data.";
    } finally {
      stale = false;
    }
  }

  // Signed in: load data, go live, and sign out after inactivity.
  $effect(() => {
    if (auth?.step !== "ready") return;
    refresh();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsub = db.subscribe((e) => {
      if (e.table === "quotes" && e.type === "INSERT") {
        unseen++;
        const lead = leads.find((l) => l.id === e.row.lead_id);
        toast.info("New quote request", `${lead?.company || lead?.name || "A new lead"} · ${money(Number(e.row.monthly_total ?? 0))}/mo`, e.row.lead_id ? { href: `#/leads/${e.row.lead_id}`, label: "Open lead" } : undefined);
      }
      clearTimeout(pending);
      pending = setTimeout(refresh, 400);
    });
    // Quotes you send: a client opening, accepting or asking for changes refreshes the lists.
    const unsubQuotes = db.subscribeProposals(() => { clearTimeout(pending); pending = setTimeout(refresh, 600); });
    live = true;
    const stopIdle = watchIdle(IDLE_MS, () => db.signOut());
    return () => { unsub(); unsubQuotes(); stopIdle(); clearTimeout(pending); live = false; };
  });

  // The browser tab names the page you are on.
  const pageTitle = $derived.by(() => {
    switch (route.page) {
      case "overview": return "Overview";
      case "leads": return "Leads";
      case "board": return "Leads";
      case "lead": { const l = leads.find((x) => x.id === route.id); return l ? l.company || l.name : "Lead"; }
      case "clients": return "Clients";
      case "client": { const c = clients.find((x) => x.id === route.id); return c ? c.company || c.contact_name || "Client" : "Client"; }
      case "projects": return "Projects";
      case "project": return projects.find((x) => x.id === route.id)?.name ?? "Project";
      case "services": return "Services";
      case "quotes": return "Quotes";
      case "quote": { const q = proposals.find((x) => x.id === route.id); return q ? `Q${q.number}` : "Quote"; }
      case "quote-templates": return "Quote templates";
      case "quote-settings": return "Quote settings";
      case "payments": return "Payments";
      case "reports": return "Reports";
      case "report": return "Report";
      case "report-settings": return "Report settings";
      case "report-template": return "Report template";
      default: return "Page not found";
    }
  });
  $effect(() => {
    const page = auth?.step === "ready" ? pageTitle : auth ? "Sign in" : "";
    document.title = `${unseen ? `(${unseen}) ` : ""}${page ? `${page} · ` : ""}cyberxLA Admin`;
  });
  $effect(() => {
    const clear = () => { if (document.visibilityState === "visible") setTimeout(() => (unseen = 0), 1500); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  });

  async function setStatus(id: string, status: LeadStatus) {
    const l = leads.find((x) => x.id === id);
    const before = l?.status;
    if (l) l.status = status;
    try {
      await db.setLeadStatus(id, status);
    } catch (e) {
      if (l && before) l.status = before;
      toast.error(`Couldn't change the stage. ${messageOf(e, "Try again.")}`);
    }
  }

  // The menu, grouped by what the pages are for. The leads board is a view of
  // Leads (the page has a List and Board switch), so it has no item of its own.
  const nav = [
    { group: "", items: [
      { href: "#/", label: "Overview", match: ["overview"], icon: "M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-3H4z" },
    ] },
    { group: "Sales", items: [
      { href: "#/leads", label: "Leads", match: ["leads", "lead", "board"], icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.87M15.5 4.13a3 3 0 0 1 0 5.74" },
      { href: "#/quotes", label: "Quotes", match: ["quotes", "quote", "quote-templates", "quote-settings", "payments"], icon: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3" },
    ] },
    { group: "Client work", items: [
      { href: "#/clients", label: "Clients", match: ["clients", "client"], icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01" },
      { href: "#/projects", label: "Projects", match: ["projects", "project"], icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18" },
      { href: "#/reports", label: "Reports", match: ["reports", "report", "report-settings", "report-template"], icon: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6M10 9h2" },
    ] },
    { group: "Catalog", items: [
      { href: "#/services", label: "Services", match: ["services"], icon: "M12 2 3 7l9 5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" },
    ] },
  ];

  // The highlight glides to whichever item is active.
  let navEl = $state<HTMLElement | null>(null);
  let pillY = $state(0);
  let pillH = $state(0);
  let pillShow = $state(false);
  $effect(() => {
    void route.page;
    const a = navEl?.querySelector<HTMLElement>('a[aria-current="page"]');
    pillShow = !!a;
    if (a) {
      pillY = a.offsetTop;
      pillH = a.offsetHeight;
    }
  });
  // The leads list and board are one page with a switch, so it keeps its search when you flip it.
  const pageKey = $derived((route.page === "board" ? "leads" : route.page) + ("id" in route ? route.id : ""));

  // The menu on narrow screens: a drawer. Closed, nothing in it can be reached
  // by keyboard; open, the page behind it can't, and Escape or a tap outside closes it.
  let narrow = $state(matchMedia("(max-width: 860px)").matches);
  let menuBtn = $state<HTMLButtonElement | null>(null);
  let railEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const mq = matchMedia("(max-width: 860px)");
    const on = () => {
      narrow = mq.matches;
      if (!mq.matches) navOpen = false;
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  async function openNav() {
    navOpen = true;
    await tick();
    (railEl?.querySelector<HTMLElement>('nav a[aria-current="page"]') ?? railEl?.querySelector<HTMLElement>("nav a"))?.focus();
  }
  async function closeNav() {
    if (!navOpen) return;
    navOpen = false;
    // The Menu button can take focus again once the page behind is live.
    await tick();
    menuBtn?.focus();
  }
</script>

{#if auth === null}
  <div class="boot" role="status" aria-label="Loading cyberxLA Admin"><Brand admin size={24} /></div>
{:else if auth.step !== "ready"}
  <Login {auth} onauth={(s) => (auth = s)} />
{:else}
  <!-- First stop for the keyboard: past the menu, straight to the page. -->
  <button class="skip" onclick={() => document.querySelector<HTMLElement>("main h1")?.focus()}>Skip to content</button>
  <div class="shell">
    <aside class="rail" id="main-menu" class:open={navOpen} bind:this={railEl} inert={narrow && !navOpen}>
      <div class="railtop">
        <a class="brand" href="#/" aria-label="cyberxLA Admin, overview"><Brand admin size={22} /></a>
        <button class="closenav" aria-label="Close menu" onclick={closeNav}><Icon name="close" size={20} /></button>
      </div>
      <nav bind:this={navEl} aria-label="Main">
        <span class="pill" class:show={pillShow} aria-hidden="true" style:transform="translateY({pillY}px)" style:height="{pillH}px"></span>
        {#each nav as g (g.group)}
          <div class="navgroup" role="group" aria-label={g.group || undefined}>
            {#if g.group}<p class="grouplabel" aria-hidden="true">{g.group}</p>{/if}
            {#each g.items as n (n.href)}
              <a href={n.href} aria-current={n.match.includes(route.page) ? "page" : undefined}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
                <span class="label">{n.label}</span>
                {#if n.label === "Leads" && newCount}<span class="badge num">{newCount}<span class="sr-only"> new</span></span>{/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>
      <div class="me">
        <span class="live" class:on={live}><i aria-hidden="true"></i>{live ? "Live" : "Offline"}</span>
        <span class="email muted">{auth.email}</span>
        <button class="btn sm" onclick={() => db.signOut()}>Sign out</button>
        {#if db.demo}<span class="demo">Demo data</span>{/if}
      </div>
    </aside>

    {#if navOpen}<button class="scrim" tabindex="-1" aria-label="Close menu" onclick={closeNav}></button>{/if}

    <div class="topbar" inert={narrow && navOpen}>
      <button class="menubtn" bind:this={menuBtn} aria-expanded={navOpen} aria-controls="main-menu" onclick={openNav}><Icon name="menu" size={20} /><span class="sr-only">Menu</span></button>
      <a class="brand" href="#/" aria-label="cyberxLA Admin, overview"><Brand size={19} /></a>
      <!-- Which page this is, for the eye; the page's own heading says it to screen readers. -->
      <span class="where" aria-hidden="true">{pageTitle}</span>
      <span class="live" class:on={live}><i aria-hidden="true"></i><span class="sr-only">{live ? "Live" : "Offline"}</span></span>
    </div>

    <main class="content" inert={narrow && navOpen}>
      <!-- A thin line while the lists reload in the background, in place of dimming the page. -->
      {#if stale && loaded}<div class="progress" aria-hidden="true"></div>{/if}
      {#if loadError}
        <p class="error banner" role="alert">{loadError} <button class="btn sm" onclick={refresh}>Retry</button></p>
      {/if}
      {#if !loaded}
        {#if !loadError}<Skeleton rows={6} />{/if}
      {:else}
      {#key pageKey}
      <div class="page" in:fly={{ y: 6, duration: ms(160), easing: cubicOut }}>
      {#if route.page === "overview"}
        <Overview leads={activeLeads} quotes={activeQuotes} {clients} {clientLines} />
      {:else if route.page === "leads" || route.page === "board"}
        <Leads {leads} quotes={activeQuotes} {clients} view={route.page === "board" ? "board" : "list"} onstatus={setStatus} />
      {:else if route.page === "lead"}
        <LeadDetail id={route.id} {version} onstatus={setStatus} clientFor={clients.find((c) => c.lead_id === route.id)?.id ?? null} onconverted={refresh}
          projects={projects.filter((p) => p.lead_id === route.id)} {projectLines} />
      {:else if route.page === "clients"}
        <Clients {clients} services={clientLines} />
      {:else if route.page === "client"}
        <ClientDetail id={route.id} {version} projects={projects.filter((p) => p.client_id === route.id)} {projectLines} />
      {:else if route.page === "projects"}
        <Projects {projects} lines={projectLines} {clients} {leads} />
      {:else if route.page === "project"}
        <ProjectDetail id={route.id} {version} {clients} {leads} quotes={activeQuotes} />
      {:else if route.page === "services"}
        <Services />
      {:else if route.page === "quotes"}
        <Quotes {proposals} {clients} {leads} onchanged={refresh} />
      {:else if route.page === "quote"}
        {#await import("./pages/QuoteDetail.svelte")}{@render pageLoading()}{:then { default: QuoteDetail }}<QuoteDetail id={route.id} autosend={route.send} {version} {clients} {leads} {projects} onchanged={refresh} />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "quote-templates"}
        {#await import("./pages/QuoteTemplates.svelte")}{@render pageLoading()}{:then { default: QuoteTemplates }}<QuoteTemplates />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "quote-settings"}
        {#await import("./pages/QuoteSettings.svelte")}{@render pageLoading()}{:then { default: QuoteSettings }}<QuoteSettings />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "payments"}
        {#await import("./pages/Payments.svelte")}{@render pageLoading()}{:then { default: Payments }}<Payments {proposals} />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "reports"}
        <!-- The report pages load on first visit, so they don't slow down the rest. -->
        {#await import("./pages/Reports.svelte")}{@render pageLoading()}{:then { default: Reports }}<Reports />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "report"}
        {#await import("./pages/ReportDetail.svelte")}{@render pageLoading()}{:then { default: ReportDetail }}<ReportDetail id={route.id} />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "report-settings"}
        {#await import("./pages/ReportSettings.svelte")}{@render pageLoading()}{:then { default: ReportSettings }}<ReportSettings {clients} />{:catch}{@render pageFailed()}{/await}
      {:else if route.page === "report-template"}
        {#await import("./pages/ReportTemplate.svelte")}{@render pageLoading()}{:then { default: ReportTemplate }}<ReportTemplate />{:catch}{@render pageFailed()}{/await}
      {:else}
        <div class="empty"><h1 class="nf" use:pageHeading>Page not found</h1><p>That address doesn't match a page. <a href="#/">Go to the overview</a></p></div>
      {/if}
      </div>
      {/key}
      {/if}
    </main>
  </div>
  <Toast />
{/if}

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && navOpen) closeNav(); }} />

{#snippet pageLoading()}<Skeleton />{/snippet}
<!-- The page's code didn't arrive: offline, or a new version went live while this tab was open. -->
{#snippet pageFailed()}
  <div class="banner" role="alert">
    <p class="error">This page couldn't load. If a new version just went live, reloading fixes it.</p>
    <button class="btn sm" onclick={() => location.reload()}>Reload</button>
  </div>
{/snippet}

<style>
  .boot { min-height: 100dvh; display: grid; place-items: center; opacity: 0.7; }
  .skip { position: fixed; left: 12px; top: 12px; z-index: 80; height: var(--control-md); padding: 0 16px; border: 1px solid var(--lime); border-radius: var(--radius-pill); background: var(--ink); color: var(--text); font-weight: 600; font-size: var(--fs-md); transform: translateY(-200%); }
  .skip:focus { transform: none; }
  .progress { position: fixed; left: 0; right: 0; top: 0; z-index: 60; height: 2px; background: linear-gradient(90deg, transparent, var(--lime), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: slide 1s linear infinite; animation-delay: 0.4s; opacity: 0; }
  @keyframes slide { from { background-position: -50% 0; opacity: 1; } to { background-position: 150% 0; opacity: 1; } }
  .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100dvh; }
  .rail { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 28px; padding: 22px 16px; border-right: 1px solid var(--line); background: var(--ink); }
  .brand { display: inline-flex; padding: 4px 10px; text-decoration: none; border-radius: var(--radius-sm); }
  .railtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .closenav, .scrim { display: none; }
  .nf { font-size: var(--fs-xl); letter-spacing: -0.02em; color: var(--text); margin-bottom: 6px; }
  nav { position: relative; display: flex; flex-direction: column; gap: 14px; }
  .navgroup { display: flex; flex-direction: column; gap: 4px; }
  .grouplabel { padding: 0 12px 2px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .pill {
    position: absolute; left: 0; right: 0; top: 0; z-index: 0; border-radius: var(--radius-md); pointer-events: none; opacity: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02)), var(--surface-2);
    border: 1px solid var(--line-2);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 4px rgba(214, 255, 63, 0.03);
    transition: transform 0.25s var(--ease), height 0.25s var(--ease), opacity 0.2s var(--ease);
  }
  .pill.show { opacity: 1; }
  nav a { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-md); text-decoration: none; font-weight: 500; color: var(--text-2); transition: color 0.25s var(--ease), background 0.25s var(--ease); }
  nav a svg { flex: none; color: var(--muted); transition: color 0.2s var(--ease); }
  nav a:hover:not([aria-current="page"]) { color: var(--text); background: rgba(255, 255, 255, 0.03); }
  nav a:hover svg { color: var(--text-2); }
  nav a[aria-current="page"] { color: var(--text); font-weight: 600; }
  nav a[aria-current="page"] svg { color: var(--lime); }
  .label { flex: 1; }
  .badge { font-size: var(--fs-xs); font-weight: 700; background: var(--lime); color: var(--on-lime); border-radius: var(--radius-pill); padding: 1px 7px; }
  .page { min-width: 0; }
  .me { margin-top: auto; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 0 8px; font-size: var(--fs-sm); }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .live { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
  .live i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .live.on { color: var(--text-2); }
  .live.on i { background: var(--good); box-shadow: 0 0 0 3px rgba(12, 163, 12, 0.25); animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(12, 163, 12, 0); } }
  .demo { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warning); }
  .content { padding: 28px clamp(16px, 3vw, 40px) 64px; max-width: 1480px; width: 100%; min-width: 0; }
  .banner { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .topbar { display: none; }
  @media (max-width: 860px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .topbar { display: flex; align-items: center; gap: 4px; position: sticky; top: 0; z-index: 20; height: 52px; padding: 0 12px 0 6px; background: var(--ink); border-bottom: 1px solid var(--line); }
    .menubtn { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border: 0; border-radius: var(--radius-md); background: none; color: var(--text); }
    .menubtn:hover { background: var(--surface-2); }
    .where { flex: 1; min-width: 0; padding-left: 10px; margin-left: 2px; border-left: 1px solid var(--line-2); font-size: var(--fs-md); font-weight: 600; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail { position: fixed; z-index: 30; inset: 0 auto 0 0; width: 260px; transform: translateX(-100%); transition: transform 0.35s var(--ease); }
    .rail.open { transform: none; box-shadow: 20px 0 60px rgba(0,0,0,0.6); }
    .closenav { display: grid; place-items: center; width: 40px; height: 40px; border: 0; border-radius: var(--radius-md); background: none; color: var(--text-2); font-size: var(--fs-xl); line-height: 1; }
    .closenav:hover { color: var(--text); background: var(--surface-2); }
    .scrim { display: block; position: fixed; inset: 0; z-index: 25; border: 0; padding: 0; background: rgba(0, 0, 0, 0.6); cursor: default; }
  }
  @media (prefers-reduced-motion: reduce) { .live.on i { animation: none; } }
</style>
