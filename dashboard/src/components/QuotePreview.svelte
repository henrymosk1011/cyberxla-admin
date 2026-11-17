<script lang="ts">
  // The live preview: the real quote page from cyberx.la in a frame, sent the
  // draft as you type (postMessage; the page accepts it only from
  // admin.cyberx.la). It never loads a quote by its link, so it never counts as a view.
  import type { PageModel } from "../../../supabase/functions/_shared/proposal.ts";
  import { PROPOSAL_ORIGIN } from "../lib/quotes.ts";

  let { model, label = "Quote preview" }: { model: PageModel | null; label?: string } = $props();

  const saved = (() => { try { return localStorage.getItem("quote.preview") === "phone" ? "phone" : "desktop"; } catch { return "desktop"; } })();
  let device = $state<"desktop" | "phone">(saved);
  let frame = $state<HTMLIFrameElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  let ready = $state(false);
  let failed = $state(false);
  let boxW = $state(0);
  let boxH = $state(0);

  const width = $derived(device === "phone" ? 375 : 1280);
  const scale = $derived(boxW ? Math.min(1, boxW / width) : 1);
  const src = `${PROPOSAL_ORIGIN}/proposal/?preview=1`;

  function pick(d: "desktop" | "phone") {
    device = d;
    try { localStorage.setItem("quote.preview", d); } catch { /* not remembered; fine */ }
  }

  $effect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== PROPOSAL_ORIGIN || e.source !== frame?.contentWindow) return;
      if ((e.data as { type?: string })?.type === "cyberxla:quote-ready") { ready = true; failed = false; post(); }
    };
    window.addEventListener("message", onMsg);
    const t = setTimeout(() => { if (!ready) failed = true; }, 12000);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  function post() {
    if (!ready || !model || !frame?.contentWindow) return;
    frame.contentWindow.postMessage({ type: "cyberxla:quote-preview", model: $state.snapshot(model) }, PROPOSAL_ORIGIN);
  }
  $effect(() => {
    void JSON.stringify(model);
    clearTimeout(timer);
    timer = setTimeout(post, 120);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => { boxW = e!.contentRect.width; boxH = e!.contentRect.height; });
    ro.observe(box);
    return () => ro.disconnect();
  });
</script>

<div class="pv">
  <div class="bar">
    <div class="seg" role="group" aria-label="Preview size">
      <button type="button" aria-pressed={device === "desktop"} onclick={() => pick("desktop")}>Desktop</button>
      <button type="button" aria-pressed={device === "phone"} onclick={() => pick("phone")}>Phone</button>
    </div>
    <span class="muted note">{failed ? "" : ready ? "Updates as you type" : "Loading the quote page…"}</span>
  </div>
  <div class="stage" bind:this={box} class:phone={device === "phone"}>
    {#if failed && !ready}
      <p class="muted fail">The preview couldn't load the quote page from {PROPOSAL_ORIGIN}. Check your connection, then reload.</p>
    {/if}
    <iframe
      bind:this={frame} {src} title={label}
      style:width="{width}px" style:height="{boxH ? Math.max(400, boxH / scale) : 900}px" style:transform="scale({scale})"
      onload={() => { /* the page says when it's ready */ }}
    ></iframe>
  </div>
</div>

<style>
  .pv { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .note { font-size: var(--fs-xs); }
  .stage { position: relative; flex: 1; min-height: 480px; overflow: hidden; border: 1px solid var(--line-2); border-radius: var(--radius-md); background: #e3e7e6; }
  .stage.phone { display: flex; justify-content: center; }
  iframe { border: 0; transform-origin: 0 0; display: block; background: #e3e7e6; }
  .stage.phone iframe { transform-origin: top center; }
  .fail { position: absolute; inset: 16px; font-size: var(--fs-sm); color: #3d4146; }
</style>
