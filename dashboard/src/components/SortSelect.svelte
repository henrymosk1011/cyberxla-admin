<script lang="ts" generics="K extends string">
  // Sorting for narrow screens, where a table's column headings are hidden:
  // a dropdown of the columns and a button for the direction.
  import type { Sort, SortDir } from "../lib/sort.ts";

  let { id, columns, sort, onchange }: {
    id: string;
    columns: readonly { key: K; label: string; first: SortDir }[];
    sort: Sort<K>;
    onchange: (s: Sort<K>) => void;
  } = $props();
</script>

<div class="sortselect">
  <label for={id}>Sort by</label>
  <select {id} class="input" value={sort.key} onchange={(e) => { const c = columns.find((x) => x.key === e.currentTarget.value)!; onchange({ key: c.key, dir: c.first }); }}>
    {#each columns as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
  </select>
  <button type="button" class="btn sm" aria-label="Sort direction: {sort.dir === 'asc' ? 'ascending' : 'descending'}. Press to switch."
    onclick={() => onchange({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}>
    <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span> {sort.dir === "asc" ? "Ascending" : "Descending"}
  </button>
</div>

<style>
  .sortselect { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  label { font-size: var(--fs-sm); color: var(--text-2); }
  .input { height: var(--control-md); width: auto; padding: 0 36px 0 12px; background-position: right 12px center; font-size: var(--fs-md); }
  .btn { height: var(--control-md); }
</style>
