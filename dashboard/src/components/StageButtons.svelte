<script lang="ts" generics="S extends string">
  // The row of buttons at the top of a lead, client or project that sets its
  // stage or status. The current one is pressed.
  import StatusPill from "./StatusPill.svelte";
  import { STATUS_LABEL } from "../lib/format.ts";

  let { label, options, value, onpick }: { /** "Stage" or "Status", for screen readers. */ label: string; options: readonly S[]; value: S; onpick: (s: S) => void } = $props();
</script>

<div class="stages" role="group" aria-label={label}>
  {#each options as s (s)}
    <button class="stage" aria-pressed={value === s} onclick={() => onpick(s)}><StatusPill status={s} bare />{STATUS_LABEL[s] ?? s}</button>
  {/each}
</div>

<style>
  .stages { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 20px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; height: var(--control-md); padding: 0 14px; border-radius: var(--radius-pill); border: 1px solid var(--line-2); background: var(--surface); color: var(--text-2); font-size: var(--fs-sm); font-weight: 600; transition: background 0.2s, color 0.2s, border-color 0.2s; }
  .stage:hover { background: var(--surface-2); color: var(--text); }
  .stage[aria-pressed="true"] { background: var(--surface-3); color: var(--text); border-color: var(--text-2); }
</style>
