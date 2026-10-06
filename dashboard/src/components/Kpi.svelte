<script lang="ts">
  let {
    label, value, hint = "", delta = null, deltaLabel = "", hero = false, spark = [],
  }: { label: string; value: string; hint?: string; delta?: number | null; deltaLabel?: string; hero?: boolean; spark?: number[] } = $props();

  const W = 120, H = 32;
  const points = $derived.by(() => {
    if (spark.length < 2) return [];
    const max = Math.max(...spark, 1);
    return spark.map((v, i) => [(i / (spark.length - 1)) * (W - 8) + 4, H - 4 - (v / max) * (H - 8)] as const);
  });
  const path = $derived(points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(""));
  const last = $derived(points.at(-1));
</script>

<div class="kpi" class:hero>
  <div class="eyebrow">{label}</div>
  <div class="value">{value}</div>
  <div class="foot">
    {#if delta !== null}
      <span class="delta" class:up={delta > 0} class:down={delta < 0}>
        <span aria-hidden="true">{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"}</span>
        {delta > 0 ? "+" : ""}{delta}{deltaLabel ? " " + deltaLabel : ""}
      </span>
    {/if}
    {#if hint}<span class="hint">{hint}</span>{/if}
  </div>
  {#if points.length}
    <svg class="spark" viewBox="0 0 {W} {H}" width={W} height={H} aria-hidden="true">
      <path d={path} fill="none" stroke="var(--muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {#if last}<circle cx={last[0]} cy={last[1]} r="4" fill="var(--lime)" stroke="var(--surface)" stroke-width="2" />{/if}
    </svg>
  {/if}
</div>

<style>
  .kpi { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .value { font-size: 30px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; }
  .hero .value { font-size: 52px; letter-spacing: -0.045em; color: var(--lime); }
  .foot { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 13px; color: var(--muted); }
  .delta { font-weight: 600; color: var(--text-2); }
  .delta.up { color: var(--good-text); }
  .delta.down { color: var(--critical); }
  .delta span { font-size: 9px; vertical-align: 1px; }
  .spark { display: block; margin-top: 6px; max-width: 100%; }
</style>
