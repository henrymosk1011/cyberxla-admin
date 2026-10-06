<script lang="ts">
  import db from "$db";
  import Login from "./pages/Login.svelte";
  import Overview from "./pages/Overview.svelte";
  import Leads from "./pages/Leads.svelte";
  import LeadDetail from "./pages/LeadDetail.svelte";
  import Toast from "./components/Toast.svelte";
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
  const newCount = $derived(leads.filter((l) => l.status === "new").length);

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
    document.title = unseen ? `(${unseen}) cyberXLA Admin` : "cyberXLA Admin";
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
    { href: "#/", label: "Overview", match: ["overview"] },
    { href: "#/leads", label: "Leads", match: ["leads", "lead"] },
    { href: "#/board", label: "Board", match: ["board"] },
  ];
</script>

{#if auth === null}
  <div class="boot" aria-busy="true"></div>
{:else if auth.step !== "ready"}
  <Login {auth} onauth={(s) => (auth = s)} />
{:else}
  <div class="shell">
    <aside class="rail" class:open={navOpen}>
      <div class="brand"><span class="mark" aria-hidden="true">×</span>cyberXLA <span class="muted">Admin</span></div>
      <nav>
        {#each nav as n (n.href)}
          <a href={n.href} aria-current={n.match.includes(route.page) ? "page" : undefined}>
            {n.label}
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
      <div class="brand"><span class="mark" aria-hidden="true">×</span>cyberXLA</div>
      <span class="live" class:on={live}><i aria-hidden="true"></i></span>
    </div>

    <main class="content">
      {#if loadError}
        <p class="error banner" role="alert">{loadError} <button class="btn sm" onclick={refresh}>Retry</button></p>
      {/if}
      {#if !loaded}
        <p class="muted">Loading…</p>
      {:else if route.page === "overview"}
        <Overview {leads} {quotes} {stale} />
      {:else if route.page === "leads" || route.page === "board"}
        <Leads {leads} {quotes} {stale} view={route.page === "board" ? "board" : "list"} onstatus={setStatus} />
      {:else if route.page === "lead"}
        <LeadDetail id={route.id} {version} onstatus={setStatus} />
      {:else}
        <p class="empty">Page not found. <a href="#/">Go to overview</a></p>
      {/if}
    </main>
  </div>
  <Toast {toasts} {dismiss} />
{/if}

<style>
  .boot { min-height: 100dvh; }
  .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100dvh; }
  .rail { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 28px; padding: 22px 16px; border-right: 1px solid var(--line); background: var(--ink); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -0.02em; padding: 0 8px; }
  .mark { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--plane); color: var(--lime); font-size: 18px; font-weight: 800; border: 1px solid var(--line-2); }
  nav { display: flex; flex-direction: column; gap: 2px; }
  nav a { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-radius: 10px; text-decoration: none; font-weight: 500; color: var(--text-2); }
  nav a:hover { background: var(--surface); color: var(--text); }
  nav a[aria-current="page"] { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--lime); }
  .badge { font-size: 11px; font-weight: 700; background: var(--lime); color: var(--on-lime); border-radius: 999px; padding: 1px 7px; }
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
    .rail { position: fixed; z-index: 30; inset: 0 auto 0 0; width: 260px; transform: translateX(-100%); transition: transform 0.2s ease; }
    .rail.open { transform: none; box-shadow: 20px 0 60px rgba(0,0,0,0.6); }
  }
  @media (prefers-reduced-motion: reduce) { .live.on i { animation: none; } }
</style>
