<script lang="ts">
  import type { Snippet } from "svelte";
  let { open, title, onclose, children, wide = false, persistent = false }: {
    open: boolean; title: string; onclose: () => void; children: Snippet; wide?: boolean;
    /** True while the form inside has input that would be lost: a click outside then doesn't close it (Escape and the buttons still do). */
    persistent?: boolean;
  } = $props();
  let dlg = $state<HTMLDialogElement | null>(null);
  const uid = $props.id();
  $effect(() => {
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  });
</script>

<dialog bind:this={dlg} class:wide onclose={onclose} onclick={(e) => { if (e.target === dlg && !persistent) onclose(); }} aria-labelledby="{uid}-title">
  {#if open}
    <div class="inner">
      <header>
        <h2 id="{uid}-title">{title}</h2>
        <button type="button" class="iconbtn close" aria-label="Close" onclick={onclose}>×</button>
      </header>
      {@render children()}
    </div>
  {/if}
</dialog>

<style>
  dialog { margin: auto; width: min(560px, calc(100% - 24px)); max-height: calc(100dvh - 24px); border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: 0; box-shadow: var(--shadow-lg); }
  dialog.wide { width: min(760px, calc(100% - 24px)); }
  dialog[open] { animation: pop-in 0.35s var(--ease) both; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(2px); }
  @keyframes pop-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } }
  .inner { padding: 24px; display: flex; flex-direction: column; gap: 18px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { font-size: var(--fs-xl); letter-spacing: -0.02em; }
  .close { width: 32px; height: var(--control-sm); font-size: var(--fs-xl); }
  @media (max-width: 560px) { .inner { padding: 18px; } }
</style>
