<script lang="ts">
  // The A to F security grade as a badge. The letter carries the meaning; the
  // color (green, amber, red) only reinforces it.
  import type { AuditGrade } from "../lib/types.ts";
  let { grade, score = null, size = "md" }: { grade: AuditGrade | null; score?: number | null; size?: "sm" | "md" | "lg" } = $props();
  const tier = (g: AuditGrade) => (g === "A" || g === "B" ? "good" : g === "C" || g === "D" ? "warn" : "bad");
</script>

{#if grade}
  <span class="grade t-{tier(grade)} s-{size}" title={score !== null ? `Score ${score} of 100` : undefined} aria-label="Grade {grade}{score !== null ? `, score ${score} of 100` : ''}">{grade}</span>
{:else}
  <span class="grade t-none s-{size}" aria-label="Not graded yet">n/a</span>
{/if}

<style>
  .grade {
    display: inline-grid; place-items: center; flex: none; font-weight: 800; line-height: 1;
    border-radius: var(--radius-sm); border: 1px solid transparent; letter-spacing: 0.01em;
  }
  .s-sm { min-width: 22px; height: 22px; padding: 0 5px; font-size: var(--fs-sm); }
  .s-md { min-width: 30px; height: 30px; padding: 0 7px; font-size: var(--fs-lg); }
  .s-lg { min-width: 52px; height: 52px; padding: 0 10px; font-size: 1.9rem; border-radius: var(--radius-md); }
  .t-good { color: var(--good-text); background: color-mix(in srgb, var(--good) 16%, transparent); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
  .t-warn { color: var(--warning); background: color-mix(in srgb, var(--warning) 15%, transparent); border-color: color-mix(in srgb, var(--warning) 42%, transparent); }
  .t-bad { color: #ff6b6b; background: color-mix(in srgb, #ff6b6b 15%, transparent); border-color: color-mix(in srgb, #ff6b6b 42%, transparent); }
  .t-none { color: var(--muted); background: var(--surface-2); border-color: var(--line-2); font-weight: 600; letter-spacing: 0; }
  .t-none.s-lg { font-size: var(--fs-lg); }
</style>
