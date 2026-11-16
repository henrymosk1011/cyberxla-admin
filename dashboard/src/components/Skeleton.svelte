<script lang="ts">
  // Gray bars in the shape of a page, shown while its data loads.
  let { rows = 5 }: { rows?: number } = $props();
</script>

<div class="skeleton" role="status" aria-label="Loading">
  <div class="bar title"></div>
  <div class="card">
    {#each Array(rows) as _, i (i)}<div class="bar row"></div>{/each}
  </div>
</div>

<style>
  .skeleton { display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
  .card { display: flex; flex-direction: column; gap: 18px; }
  .bar { border-radius: var(--radius-sm); background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  .title { width: 220px; height: 34px; }
  .row { height: 18px; }
  .row:nth-child(2n) { width: 82%; }
  .row:nth-child(3n) { width: 64%; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
</style>
