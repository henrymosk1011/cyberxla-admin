<script lang="ts">
  import { STATUS_LABEL } from "../lib/format.ts";
  let { status }: { status: string } = $props();
</script>

<span class="pill st-{status}"><i aria-hidden="true"></i>{STATUS_LABEL[status] ?? status}</span>

<style>
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--text-2); white-space: nowrap; }
  i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 2px var(--surface); }
  .st-new i, .st-submitted i { background: var(--st-new); }
  .st-contacted i, .st-reviewing i { background: var(--st-contacted); }
  .st-proposal i, .st-sent i { background: var(--st-proposal); }
  .st-won i, .st-accepted i { background: var(--st-won); }
  .st-lost i, .st-declined i { background: var(--st-lost); }
</style>
