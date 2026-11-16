<script lang="ts">
  // The bar along the bottom of a page you edit and then save. It is always on
  // screen, so the result of Save shows here too: what went wrong, or Saved.
  import Icon from "./Icon.svelte";
  let { dirty, busy = false, label = "Save", hint = "Unsaved changes", error = "", done = "", onsave, ondiscard }: {
    dirty: boolean;
    busy?: boolean;
    /** The Save button's words. */
    label?: string;
    /** Shown while there are unsaved changes. */
    hint?: string;
    /** Why the last Save didn't go through. */
    error?: string;
    /** What the last Save did, for example "Saved." */
    done?: string;
    onsave: () => void;
    ondiscard: () => void;
  } = $props();
</script>

<div class="savebar" class:clean={!dirty && !error} class:bad={!!error} role="region" aria-label="Save">
  <div class="msg">
    {#if error}
      <p class="err" role="alert">{error}</p>
    {:else if done && !dirty}
      <p class="ok" role="status"><Icon name="check" size={14} /> {done}</p>
    {:else}
      <p>{dirty ? hint : "No unsaved changes"}</p>
    {/if}
  </div>
  <div class="btns">
    {#if dirty}<button class="btn ghost" disabled={busy} onclick={ondiscard}>Discard</button>{/if}
    <button class="btn primary" disabled={busy || !dirty} onclick={onsave}>{busy ? "Saving…" : label}</button>
  </div>
</div>

<style>
  .savebar { position: sticky; bottom: 12px; z-index: 10; margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--lime); border-radius: var(--radius); background: var(--surface-2); box-shadow: var(--shadow-md); font-size: var(--fs-md); font-weight: 600; }
  .savebar.clean { border-color: var(--line-2); box-shadow: var(--shadow-sm); font-weight: 500; color: var(--text-2); }
  .savebar.bad { border-color: var(--critical); }
  .msg { flex: 1 1 240px; min-width: 0; }
  .err { color: var(--critical); overflow-wrap: anywhere; }
  .ok { color: var(--good-text); }
  .btns { display: flex; gap: 8px; }
</style>
