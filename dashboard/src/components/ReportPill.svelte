<script lang="ts">
  // A report's status in words, with a colored dot. The word carries the meaning; the color only helps.
  import type { StateTone } from "../lib/reports.ts";
  let { label, tone, test = false }: { label: string; tone: StateTone; test?: boolean } = $props();
</script>

<span class="pill t-{tone}"><i aria-hidden="true"></i>{label}</span>{#if test}<span class="test">Test</span>{/if}

<style>
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; }
  i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 2px var(--surface); flex: none; }
  .t-lime i { background: var(--lime); }
  .t-good i { background: var(--good); }
  .t-warn i { background: var(--warning); }
  .t-bad i { background: var(--critical); }
  .t-info i { background: var(--st-contacted); }
  .t-muted i { background: var(--st-lost); }
  .test { margin-left: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--on-lime); background: var(--warning); border-radius: 999px; padding: 1px 7px; }
</style>
