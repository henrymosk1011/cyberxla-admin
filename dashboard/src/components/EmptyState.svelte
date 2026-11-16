<script lang="ts">
  // What a list shows when it has nothing: what that means, and the next step
  // as a button when there is one.
  import type { Snippet } from "svelte";
  let { title, text = "", children }: { title: string; text?: string; /** The next step: a button or a link. */ children?: Snippet } = $props();
</script>

<div class="emptystate">
  <p class="title">{title}</p>
  {#if text}<p class="text">{text}</p>{/if}
  {#if children}<div class="act">{@render children()}</div>{/if}
</div>

<style>
  .emptystate { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 44px 20px; text-align: center; }
  .title { font-weight: 600; color: var(--text); }
  .text { font-size: var(--fs-md); color: var(--text-2); max-width: 460px; }
  .act { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 10px; }
</style>
