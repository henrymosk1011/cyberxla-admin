<script lang="ts">
  // A status in words with a colored dot: lead stages, and quote, client and
  // project statuses. The word carries the meaning; the color only helps.
  import { STATUS_LABEL } from "../lib/format.ts";
  let { status, bare = false }: { status: string; /** Only the dot, for a button or row that has its own words. */ bare?: boolean } = $props();
</script>

{#if bare}
  <i class="dot st-{status}" aria-hidden="true"></i>
{:else}
  <span class="pill"><i class="dot st-{status}" aria-hidden="true"></i>{STATUS_LABEL[status] ?? status}</span>
{/if}

<style>
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); font-weight: 500; color: var(--text-2); white-space: nowrap; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .st-new, .st-submitted, .st-potential { background: var(--st-new); }
  .st-contacted, .st-reviewing, .st-in_progress { background: var(--st-contacted); }
  .st-proposal, .st-sent, .st-proposed { background: var(--st-proposal); }
  .st-won, .st-accepted, .st-active, .st-done { background: var(--st-won); }
  .st-paused, .st-on_hold { background: var(--warning); }
  .st-lost, .st-declined, .st-former, .st-cancelled { background: var(--st-lost); }
</style>
