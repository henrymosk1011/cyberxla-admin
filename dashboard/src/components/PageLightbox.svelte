<script lang="ts">
  // The report preview pages, large. Opens over the page; Esc, Close or a
  // click outside closes it and focus goes back to the page you opened.
  // Left and right arrow keys, and Previous and Next, move between pages.
  import type { ReportPage } from "../lib/types.ts";

  let { pages, title }: { pages: ReportPage[]; title: string } = $props();

  let dlg = $state<HTMLDialogElement | null>(null);
  let index = $state(0);
  let opener: HTMLElement | null = null;

  // Pages can change under an open lightbox (a new render lands); stay in range.
  const at = $derived(Math.min(index, Math.max(0, pages.length - 1)));
  const page = $derived(pages[at]);

  export function open(i: number, from: HTMLElement | null) {
    index = i;
    opener = from;
    dlg?.showModal();
  }
  const close = () => dlg?.close();
  // Wraps around, so the buttons never turn off under keyboard focus.
  const go = (by: number) => {
    if (pages.length) index = (at + by + pages.length) % pages.length;
  };
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  }
</script>

<dialog
  bind:this={dlg}
  aria-labelledby="lb-title"
  onclose={() => opener?.focus()}
  onclick={(e) => { if (e.target === dlg) close(); }}
  {onkeydown}
>
  {#if page}
    <header>
      <h2 id="lb-title">{title} <span>Page {at + 1} of {pages.length}</span></h2>
      <div class="ctl">
        {#if pages.length > 1}
          <button type="button" class="btn sm" onclick={() => go(-1)}>Previous<span class="sr-only"> page</span></button>
          <button type="button" class="btn sm" onclick={() => go(1)}>Next<span class="sr-only"> page</span></button>
        {/if}
        <button type="button" class="btn sm primary" onclick={close}>Close</button>
      </div>
    </header>
    <!-- The page scrolls inside this box, so keyboard users need to be able to focus it. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="frame" role="region" aria-label="Page image" tabindex="0">
      <img src={page.src} alt="Page {at + 1} of {pages.length} of the client PDF" width="935" height="1210" />
    </div>
  {/if}
</dialog>

<style>
  dialog {
    margin: auto; padding: 0; width: min(1000px, calc(100% - 24px)); max-height: calc(100dvh - 24px);
    border: 1px solid var(--line-2); border-radius: 16px; background: var(--surface); color: var(--text);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); overflow: hidden;
  }
  dialog[open] { display: flex; flex-direction: column; animation: pop-in 0.25s var(--ease) both; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(2px); }
  @keyframes pop-in { from { opacity: 0; transform: scale(0.98); } }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  h2 { font-size: 16px; font-weight: 600; }
  h2 span { margin-left: 8px; font-weight: 500; color: var(--text-2); }
  .ctl { display: flex; gap: 8px; }
  .frame { overflow: auto; padding: 16px; background: var(--plane); }
  img { display: block; width: 100%; max-width: 935px; height: auto; margin: 0 auto; border-radius: 4px; background: #fff; }
  @media (max-width: 640px) {
    .frame { padding: 8px; }
    h2 span { display: block; margin: 2px 0 0; }
  }
</style>
