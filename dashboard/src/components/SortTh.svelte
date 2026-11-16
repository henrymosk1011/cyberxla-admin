<script lang="ts" generics="K extends string">
  // A column heading that sorts its table. Press it to sort by the column;
  // press again to flip the direction. The arrow shows which way.
  import type { Sort } from "../lib/sort.ts";

  let { key, label, sort, onsort, right = false, hide = "" }: {
    key: K;
    label: string;
    sort: Sort<K>;
    onsort: (key: K) => void;
    /** Right aligned, for numbers. */
    right?: boolean;
    /** "sm" hides the column on narrow screens, "md" below a desktop width. */
    hide?: "" | "sm" | "md";
  } = $props();
</script>

<th aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} class:r={right} class:hide-sm={hide === "sm"} class:hide-md={hide === "md"}>
  <button type="button" class="sort" class:on={sort.key === key} onclick={() => onsort(key)}>
    {label}<span class="arrow" aria-hidden="true">{sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
  </button>
</th>

<style>
  .sort {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; margin: -4px -6px; border: 0; border-radius: 6px;
    background: none; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer;
  }
  .sort:hover { color: var(--text); background: var(--surface-2); }
  .sort.on { color: var(--text); }
  .arrow { font-size: 12px; color: var(--muted); }
  .sort.on .arrow { color: var(--lime); }
  @media (max-width: 720px) { .hide-sm { display: none; } }
  @media (max-width: 1100px) { .hide-md { display: none; } }
</style>
