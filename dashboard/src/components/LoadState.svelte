<script lang="ts">
  // What a page shows before its data is in: loading, or what went wrong with
  // a way to try again.
  let { error = "", what, onretry }: { error?: string; /** "this lead", "reports" */ what: string; onretry: () => void } = $props();
</script>

{#if error}
  <div class="failed" role="alert">
    <p class="title">Couldn't load {what}</p>
    <p class="why">{error}</p>
    <button class="btn sm" onclick={onretry}>Try again</button>
  </div>
{:else}
  <p class="muted" role="status">Loading…</p>
{/if}

<style>
  .failed { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 520px; padding: 20px; border: 1px solid var(--line-2); border-left: 3px solid var(--critical); border-radius: var(--radius); background: var(--surface); }
  .title { font-weight: 600; }
  .why { font-size: var(--fs-md); color: var(--text-2); overflow-wrap: anywhere; }
</style>
