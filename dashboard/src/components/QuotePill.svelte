<script lang="ts">
  // A quote's status in words with a colored dot. The word carries the meaning.
  import { PROPOSAL_STATUS_LABEL } from "../lib/quotes.ts";
  import type { ProposalStatus } from "../lib/types.ts";
  let { status }: { status: ProposalStatus } = $props();
</script>

<span class="pill st-{status}"><i aria-hidden="true"></i>{PROPOSAL_STATUS_LABEL[status]}</span>

<style>
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); font-weight: 500; color: var(--text-2); white-space: nowrap; }
  i { width: 8px; height: 8px; border-radius: 50%; background: var(--st-lost); flex: none; }
  .st-scheduled i { background: var(--st-contacted); }
  .st-sent i, .st-viewed i { background: var(--st-proposal); }
  .st-changes_requested i { background: var(--warning); }
  .st-accepted i { background: var(--st-won); }
</style>
