<script lang="ts">
  import type { Snippet } from "svelte";
  let { open, title, onclose, children, wide = false }: { open: boolean; title: string; onclose: () => void; children: Snippet; wide?: boolean } = $props();
  let dlg = $state<HTMLDialogElement | null>(null);
  $effect(() => {
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  });
</script>

<dialog bind:this={dlg} class:wide onclose={onclose} onclick={(e) => { if (e.target === dlg) onclose(); }} aria-labelledby="modal-title">
  {#if open}
    <div class="inner">
      <header>
        <h2 id="modal-title">{title}</h2>
        <button type="button" class="x" aria-label="Close" onclick={onclose}>×</button>
      </header>
      {@render children()}
    </div>
  {/if}
</dialog>

<style>
  dialog { margin: auto; width: min(560px, calc(100% - 24px)); max-height: calc(100dvh - 24px); border: 1px solid var(--line-2); border-radius: 18px; background: var(--surface); color: var(--text); padding: 0; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); }
  dialog.wide { width: min(760px, calc(100% - 24px)); }
  dialog[open] { animation: pop-in 0.35s var(--ease) both; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(2px); }
  @keyframes pop-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } }
  .inner { padding: 24px; display: flex; flex-direction: column; gap: 18px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { font-size: 22px; letter-spacing: -0.02em; }
  .x { border: 0; background: none; color: var(--muted); font-size: 24px; line-height: 1; padding: 2px 8px; border-radius: 8px; }
  .x:hover { color: var(--text); background: var(--surface-2); }
  @media (max-width: 560px) { .inner { padding: 18px; } }
</style>
