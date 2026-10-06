<script lang="ts">
  import { ticks } from "../lib/stats.ts";

  type Datum = { label: string; value: number; detail?: string };
  let {
    data, format = (v: number) => String(v), integer = false, height = 220, label,
  }: { data: Datum[]; format?: (v: number) => string; integer?: boolean; height?: number; label: string } = $props();

  let width = $state(600);
  let hover = $state<number | null>(null);

  const pad = { top: 12, right: 8, bottom: 28, left: 44 };
  const innerW = $derived(Math.max(10, width - pad.left - pad.right));
  const innerH = $derived(height - pad.top - pad.bottom);
  const yTicks = $derived(ticks(Math.max(0, ...data.map((d) => d.value)), 4, integer));
  const yMax = $derived(yTicks.at(-1) || 1);
  const band = $derived(innerW / Math.max(1, data.length));
  const barW = $derived(Math.min(24, band * 0.62));
  const every = $derived(Math.max(1, Math.ceil(56 / band)));
  const y = (v: number) => pad.top + innerH - (v / yMax) * innerH;
  const x = (i: number) => pad.left + band * i + band / 2;

  function bar(i: number, v: number) {
    const h = (v / yMax) * innerH;
    if (h <= 0) return "";
    const r = Math.min(4, h, barW / 2), x0 = x(i) - barW / 2, x1 = x0 + barW, yb = pad.top + innerH, yt = yb - h;
    return `M${x0},${yb}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x1 - r}Q${x1},${yt} ${x1},${yt + r}V${yb}Z`;
  }
  const hd = $derived(hover === null ? undefined : data[hover]);
  const tipX = $derived(hover === null ? 0 : Math.min(Math.max(x(hover), 70), width - 70));
</script>

<div class="chart" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={label}>
    {#each yTicks as t (t)}
      <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} class:base={t === 0} />
      <text x={pad.left - 10} y={y(t)} dy="0.32em" text-anchor="end" class="tick">{format(t)}</text>
    {/each}
    {#each data as d, i (i)}
      <path d={bar(i, d.value)} class="bar" class:dim={hover !== null && hover !== i} />
      {#if i % every === (data.length - 1) % every}
        <text x={x(i)} y={height - 8} text-anchor="middle" class="tick">{d.label}</text>
      {/if}
      <rect
        x={pad.left + band * i} y={pad.top} width={band} height={innerH} class="hit"
        role="button" tabindex="0" aria-label="{d.label}: {format(d.value)}{d.detail ? ', ' + d.detail : ''}"
        onpointerenter={() => (hover = i)} onpointerleave={() => (hover = null)}
        onfocus={() => (hover = i)} onblur={() => (hover = null)}
      />
    {/each}
  </svg>
  {#if hd}
    {@const d = hd}
    <div class="tip" style:left="{tipX}px" style:top="{Math.max(0, y(d.value) - 12)}px">
      <strong>{format(d.value)}</strong>
      <span>{d.label}</span>
      {#if d.detail}<span>{d.detail}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .chart { position: relative; width: 100%; }
  svg { display: block; overflow: visible; }
  line { stroke: var(--grid); stroke-width: 1; shape-rendering: crispEdges; }
  line.base { stroke: var(--axis); }
  .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .bar { fill: var(--lime); transition: opacity 0.2s; transform-box: fill-box; transform-origin: 50% 100%; animation: grow 0.7s var(--ease) both; }
  @keyframes grow { from { transform: scaleY(0); } }
  .bar.dim { opacity: 0.35; }
  .hit { fill: transparent; outline: none; cursor: default; }
  .tip {
    position: absolute; transform: translate(-50%, -100%); pointer-events: none; z-index: 2;
    display: flex; flex-direction: column; gap: 1px; white-space: nowrap;
    background: var(--surface-3); border: 1px solid var(--line-2); border-radius: 10px; padding: 8px 12px;
    font-size: 12px; color: var(--text-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .tip strong { font-size: 15px; color: var(--text); font-weight: 650; }
</style>
