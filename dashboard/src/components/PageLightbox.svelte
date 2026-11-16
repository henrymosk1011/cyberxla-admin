<script lang="ts">
  // The report preview, large: every page one under the other, so you scroll
  // to read on. It opens at the page you clicked. Esc, Close or a click
  // outside closes it and focus goes back to the page you opened. The arrow
  // keys and Page Up and Page Down scroll; left and right arrows jump a page.
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import type { ReportPage } from "../lib/types.ts";

  let { pages, title }: { pages: ReportPage[]; title: string } = $props();

  let dlg = $state<HTMLDialogElement | null>(null);
  let frame = $state<HTMLDivElement | null>(null);
  let imgs = $state<HTMLImageElement[]>([]);
  let current = $state(0);
  let opener: HTMLElement | null = null;

  // Pages can change under an open lightbox (a new render lands); stay in range.
  const shown = $derived(Math.min(current, Math.max(0, pages.length - 1)));

  // Scroll so page i starts at the top of the box.
  function jump(i: number) {
    const n = Math.max(0, Math.min(i, pages.length - 1));
    const el = imgs[n];
    if (!frame || !el) return;
    frame.scrollTop = el.offsetTop - parseFloat(getComputedStyle(frame).paddingTop);
    current = n;
  }

  export async function open(i: number, from: HTMLElement | null) {
    opener = from;
    dlg?.showModal();
    await tick();
    jump(i);
    // Focus the pages, so the keyboard scrolls them right away.
    frame?.focus({ preventScroll: true });
  }
  const close = () => dlg?.close();

  // The page in view: the last one whose top is above a third of the box, or
  // the last page once scrolled to the bottom (on a phone it may never reach the top).
  function onscroll() {
    if (!frame) return;
    if (frame.scrollTop + frame.clientHeight >= frame.scrollHeight - 2) {
      current = pages.length - 1;
      return;
    }
    const line = frame.scrollTop + frame.clientHeight / 3;
    let n = 0;
    imgs.forEach((el, k) => {
      if (el && el.offsetTop <= line) n = k;
    });
    current = n;
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") { e.preventDefault(); jump(shown + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); jump(shown - 1); }
  }
</script>

<dialog
  bind:this={dlg}
  aria-labelledby="lb-title"
  onclose={() => opener?.focus()}
  onclick={(e) => { if (e.target === dlg) close(); }}
  {onkeydown}
>
  {#if pages.length}
    <header>
      <h2 id="lb-title">{title} <span>Page {shown + 1} of {pages.length}</span></h2>
      <button type="button" class="iconbtn close" aria-label="Close" onclick={close}><Icon name="close" size={18} /></button>
    </header>
    <!-- The pages scroll inside this box, so keyboard users need to be able to focus it. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="frame" bind:this={frame} role="region" aria-label="Report pages, scroll to read on" tabindex="0" {onscroll}>
      {#each pages as p, k (k)}
        <img bind:this={imgs[k]} src={p.src} alt="Page {k + 1} of {pages.length} of the client PDF" width="935" height="1210" />
      {/each}
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(1000px, calc(100% - 24px)); overflow: hidden; }
  dialog[open] { display: flex; flex-direction: column; }
  .close { width: 32px; height: 32px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  /* A toolbar title, smaller than a dialog's. */
  h2 { font-size: var(--fs-base); font-weight: 600; letter-spacing: 0; }
  h2 span { margin-left: 8px; font-weight: 500; color: var(--text-2); }
  /* Scrolling past the first or last page stops here, not on the page behind. */
  .frame {
    position: relative; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
    display: flex; flex-direction: column; gap: 16px; padding: 16px; background: var(--plane);
  }
  img { display: block; flex: none; width: 100%; max-width: 935px; height: auto; margin: 0 auto; border-radius: var(--radius-sm); background: #fff; }
  @media (max-width: 640px) {
    .frame { padding: 8px; gap: 8px; }
    h2 span { display: block; margin: 2px 0 0; }
  }
</style>
