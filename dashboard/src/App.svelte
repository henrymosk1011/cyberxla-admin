<script lang="ts">
  import db from "$db";
  import Login from "./pages/Login.svelte";
  import Overview from "./pages/Overview.svelte";
  import Leads from "./pages/Leads.svelte";
  import LeadDetail from "./pages/LeadDetail.svelte";
  import Toast from "./components/Toast.svelte";
  import Brand from "./components/Brand.svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { watchIdle } from "./lib/idle.ts";
  import { money } from "./lib/format.ts";
  import type { AuthState, Lead, LeadStatus, Quote, ToastMsg } from "./lib/types.ts";

  const IDLE_MS = 30 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let auth = $state<AuthState | null>(null);
  let leads = $state<Lead[]>([]);
  let quotes = $state<Quote[]>([]);
  let loaded = $state(false);
  let stale = $state(false);
  let loadError = $state("");
  let version = $state(0);
  let live = $state(false);
  let unseen = $state(0);
  let toasts = $state<ToastMsg[]>([]);
  let hash = $state(location.hash);
  let navOpen = $state(false);

  const route = $derived.by(() => {
    const h = hash.replace(/^#/, "") || "/";
    const m = h.match(/^\/leads\/([^/]+)$/);
    if (m) return UUID.test(m[1]!) ? { page: "lead" as const, id: m[1]! } : { page: "notfound" as const };
    if (h === "/leads") return { page: "leads" as const };
    if (h === "/board") return { page: "board" as const };
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
    const onHash = () => { hash = location.hash; navOpen = false; window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  db.onSignedOut(() => {
    auth = { step: "signed-out" };
    leads = []; quotes = []; loaded = false;
  });
  db.authState().then((s) => (auth = s), () => (auth = { step: "signed-out" }));

  async function refresh() {
    stale = true;
    try {
      [leads, quotes] = await Promise.all([db.leads(), db.quotes()]);
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
        notify("New quote", `${lead?.company || lead?.name || "A new lead"} · ${money(Number(e.row.monthly_total ?? 0))}/mo`, e.row.lead_id ? `#/leads/${e.row.lead_id}` : undefined);
      }
      clearTimeout(pending);
      pending = setTimeout(refresh, 400);
    });
    live = true;
    const stopIdle = watchIdle(IDLE_MS, () => db.signOut());
    return () => { unsub(); stopIdle(); clearTimeout(pending); live = false; };
  });

  $effect(() => {
    document.title = unseen ? `(${unseen}) cyberxLA Admin` : "cyberxLA Admin";
  });
  $effect(() => {
    const clear = () => { if (document.visibilityState === "visible") setTimeout(() => (unseen = 0), 1500); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  });

  let toastId = 0;
  function notify(title: string, body: string, href?: string) {
    const t = { id: ++toastId, title, body, href };
    toasts = [...toasts, t].slice(-4);
    setTimeout(() => dismiss(t.id), 12000);
  }
  const dismiss = (id: number) => (toasts = toasts.filter((t) => t.id !== id));

  async function setStatus(id: string, status: LeadStatus) {
    const l = leads.find((x) => x.id === id);
    const before = l?.status;
    if (l) l.status = status;
    try {
      await db.setLeadStatus(id, status);
    } catch (e) {
      if (l && before) l.status = before;
      notify("Couldn't update", e instanceof Error ? e.message : "Try again.");
    }
  }

  const nav = [
    { href: "#/", label: "Overview", match: ["overview"], icon: "M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-3H4z" },
    { href: "#/leads", label: "Leads", match: ["leads", "lead"], icon: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.87M15.5 4.13a3 3 0 0 1 0 5.74" },
    { href: "#/board", label: "Board", match: ["board"], icon: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z" },
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
  const pageKey = $derived(route.page + ("id" in route ? route.id : ""));
</script>

{#if auth === null}
  <div class="boot" aria-busy="true"></div>
{:else if auth.step !== "ready"}
  <Login {auth} onauth={(s) => (auth = s)} />
{:else}
  <div class="shell">
    <aside class="rail" class:open={navOpen}>
      <a class="brand" href="#/" aria-label="cyberxLA Admin, overview"><Brand admin size={22} /></a>
      <nav bind:this={navEl}>
        <span class="pill" class:show={pillShow} aria-hidden="true" style:transform="translateY({pillY}px)" style:height="{pillH}px"></span>
        {#each nav as n (n.href)}
          <a href={n.href} aria-current={n.match.includes(route.page) ? "page" : undefined}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
            <span class="label">{n.label}</span>
            {#if n.label === "Leads" && newCount}<span class="badge num">{newCount}</span>{/if}
          </a>
        {/each}
      </nav>
      <div class="me">
        <span class="live" class:on={live}><i aria-hidden="true"></i>{live ? "Live" : "Offline"}</span>
        <span class="email muted">{auth.email}</span>
        <button class="btn sm" onclick={() => db.signOut()}>Sign out</button>
        {#if db.demo}<span class="demo">Demo data</span>{/if}
      </div>
    </aside>

    <div class="topbar">
      <button class="btn ghost sm" aria-expanded={navOpen} onclick={() => (navOpen = !navOpen)}>Menu</button>
      <a class="brand" href="#/"><Brand size={19} /></a>
      <span class="live" class:on={live}><i aria-hidden="true"></i></span>
    </div>

    <main class="content">
      {#if loadError}
        <p class="error banner" role="alert">{loadError} <button class="btn sm" onclick={refresh}>Retry</button></p>
      {/if}
      {#if !loaded}
        <p class="muted">Loading…</p>
      {:else}
      {#key pageKey}
      <div class="page" in:fly={{ y: 12, duration: 380, easing: cubicOut }}>
      {#if route.page === "overview"}
        <Overview leads={activeLeads} quotes={activeQuotes} {stale} />
      {:else if route.page === "leads" || route.page === "board"}
        <Leads {leads} quotes={activeQuotes} {stale} view={route.page === "board" ? "board" : "list"} onstatus={setStatus} />
      {:else if route.page === "lead"}
        <LeadDetail id={route.id} {version} onstatus={setStatus} />
      {:else}
        <p class="empty">Page not found. <a href="#/">Go to overview</a></p>
      {/if}
      </div>
      {/key}
      {/if}
    </main>
  </div>
  <Toast {toasts} {dismiss} />
{/if}

<style>
  .boot { min-height: 100dvh; }
  .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100dvh; }
  .rail { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 28px; padding: 22px 16px; border-right: 1px solid var(--line); background: var(--ink); }
  .brand { display: inline-flex; padding: 4px 10px; text-decoration: none; border-radius: 8px; }
  nav { position: relative; display: flex; flex-direction: column; gap: 4px; }
  .pill {
    position: absolute; left: 0; right: 0; top: 0; z-index: 0; border-radius: 12px; pointer-events: none; opacity: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02)), var(--surface-2);
    border: 1px solid var(--line-2);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 4px rgba(214, 255, 63, 0.03);
    transition: transform 0.5s var(--ease-spring), height 0.3s var(--ease), opacity 0.3s var(--ease);
  }
  .pill.show { opacity: 1; }
  nav a { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; text-decoration: none; font-weight: 500; color: var(--text-2); transition: color 0.25s var(--ease), background 0.25s var(--ease); }
  nav a svg { flex: none; color: var(--muted); transition: color 0.3s var(--ease), transform 0.4s var(--ease-spring); }
  nav a:hover:not([aria-current="page"]) { color: var(--text); background: rgba(255, 255, 255, 0.03); }
  nav a:hover svg { transform: translateX(2px) scale(1.06); color: var(--text-2); }
  nav a[aria-current="page"] { color: var(--text); font-weight: 600; }
  nav a[aria-current="page"] svg { color: var(--lime); filter: drop-shadow(0 0 6px rgba(214, 255, 63, 0.45)); }
  .label { flex: 1; }
  .badge { font-size: 11px; font-weight: 700; background: var(--lime); color: var(--on-lime); border-radius: 999px; padding: 1px 7px; box-shadow: 0 0 12px rgba(214, 255, 63, 0.35); animation: pop 0.5s var(--ease-spring); }
  @keyframes pop { from { transform: scale(0.4); opacity: 0; } }
  .page { min-width: 0; }
  .me { margin-top: auto; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 0 8px; font-size: 13px; }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .live { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .live i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .live.on { color: var(--text-2); }
  .live.on i { background: var(--good); box-shadow: 0 0 0 3px rgba(12, 163, 12, 0.25); animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(12, 163, 12, 0); } }
  .demo { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warning); }
  .content { padding: 28px clamp(16px, 3vw, 40px) 64px; max-width: 1480px; width: 100%; }
  .banner { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .topbar { display: none; }
  @media (max-width: 860px) {
    .shell { grid-template-columns: 1fr; }
    .topbar { display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 20; padding: 10px 12px; background: var(--ink); border-bottom: 1px solid var(--line); }
    .rail { position: fixed; z-index: 30; inset: 0 auto 0 0; width: 260px; transform: translateX(-100%); transition: transform 0.35s var(--ease); }
    .rail.open { transform: none; box-shadow: 20px 0 60px rgba(0,0,0,0.6); }
  }
  @media (prefers-reduced-motion: reduce) { .live.on i { animation: none; } }
</style>
