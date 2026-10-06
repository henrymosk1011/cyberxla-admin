<script lang="ts">
  type Row = { key: string; label: string; value: number; display: string; detail?: string; href?: string };
  let { rows, label }: { rows: Row[]; label: string } = $props();
  const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

<ul class="bars" aria-label={label}>
  {#each rows as r (r.key)}
    <li title={r.detail ?? ""}>
      <span class="name">{r.label}</span>
      <span class="track">
        <span class="fill" class:zero={r.value === 0} style:width="calc((100% - 104px) * {r.value / max})"></span>
        <span class="val num">{r.display}</span>
      </span>
    </li>
  {/each}
</ul>

<style>
  .bars { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  li { display: grid; grid-template-columns: minmax(90px, 38%) 1fr; align-items: center; gap: 12px; font-size: 13px; }
  li:hover .fill { background: #e4ff7a; }
  li:hover .name { color: var(--text); }
  .name { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .fill { height: 12px; min-width: 2px; background: var(--lime); border-radius: 0 4px 4px 0; transition: width 0.4s ease; flex: none; }
  .fill.zero { background: var(--axis); }
  .val { color: var(--text); font-weight: 600; white-space: nowrap; flex: none; }
</style>
