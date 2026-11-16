<script lang="ts">
  import Icon from "./Icon.svelte";
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
        <button type="button" class="iconbtn close" aria-label="Close" onclick={onclose}><Icon name="close" size={18} /></button>
      </header>
      {@render children()}
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(560px, calc(100% - 24px)); }
  dialog.wide { width: min(760px, calc(100% - 24px)); }
  .inner { padding: 24px; display: flex; flex-direction: column; gap: 18px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .close { width: 32px; height: 32px; }
  @media (max-width: 560px) { .inner { padding: 18px; } }
</style>
