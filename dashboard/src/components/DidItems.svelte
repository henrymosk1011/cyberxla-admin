<script lang="ts">
  // The "What we did" items on a report: edit, remove, and reorder by
  // dragging the handle (mouse, pen or touch) or with the arrow keys on it.
  // Same handle as the Services page.
  import { tick } from "svelte";
  import { flip } from "svelte/animate";

  type Item = { title: string; text: string };
  // idPrefix keeps field ids unique when two lists are on one page.
  let { items = $bindable(), idPrefix = "d" }: { items: Item[]; idPrefix?: string } = $props();

  // Stable keys, so rows (and keyboard focus) move with their item.
  const keys = new WeakMap<object, number>();
  let nextKey = 0;
  function keyOf(o: object): number {
    let k = keys.get(o);
    if (k === undefined) keys.set(o, (k = ++nextKey));
    return k;
  }

  type Drag = { key: number; x: number; y: number; ox: number; oy: number; w: number; label: string };
  let drag = $state<Drag | null>(null);
  let list = $state<HTMLOListElement | null>(null);
  let announce = $state("");
  let raf = 0;

  const name = (it: Item) => it.title.trim() || "untitled item";

  /** Top of an element in page coordinates, ignoring transforms (so the move animation doesn't cause jitter). */
  function layoutTop(el: HTMLElement): number {
    let y = 0;
    for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
    return y;
  }

  function startDrag(e: PointerEvent, it: Item) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const box = handle.closest("li")!.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    drag = { key: keyOf(it), x: e.clientX, y: e.clientY, ox: e.clientX - box.left, oy: Math.min(e.clientY - box.top, 30), w: box.width, label: name(it) };
    raf = requestAnimationFrame(autoScroll);
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    place();
  }

  function autoScroll() {
    if (!drag) return;
    const edge = 90, h = window.innerHeight;
    const v = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > h - edge ? (drag.y - (h - edge)) / 4 : 0;
    if (v) { window.scrollBy(0, Math.round(v)); place(); }
    raf = requestAnimationFrame(autoScroll);
  }

  /** Move the dragged item to wherever the pointer is. */
  function place() {
    if (!drag || !list) return;
    const py = drag.y + window.scrollY;
    const others = [...list.querySelectorAll<HTMLElement>("li[data-key]")].filter((el) => Number(el.dataset.key) !== drag!.key);
    const to = others.filter((el) => layoutTop(el) + el.offsetHeight / 2 < py).length;
    const from = items.findIndex((x) => keyOf(x) === drag!.key);
    if (from < 0 || from === to) return;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it!);
  }

  function endDrag() {
    if (!drag) return;
    cancelAnimationFrame(raf);
    const key = drag.key;
    drag = null;
    const at = items.findIndex((x) => keyOf(x) === key);
    if (at >= 0) announce = `${name(items[at]!)} is now item ${at + 1} of ${items.length}.`;
  }

  /** Arrow keys on a handle move the item one step; focus stays on its handle. */
  async function keyMove(e: KeyboardEvent, it: Item) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const i = items.indexOf(it), j = i + (e.key === "ArrowUp" ? -1 : 1);
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j]!, items[i]!];
    announce = `${name(it)} is now item ${j + 1} of ${items.length}.`;
    await tick();
    list?.querySelector<HTMLElement>(`[data-handle="${keyOf(it)}"]`)?.focus();
  }
</script>

<svelte:window onpointermove={onMove} onpointerup={endDrag} onpointercancel={endDrag} />

{#if items.length > 1}<p class="tip">Drag <span aria-hidden="true">⠿</span> to reorder, or focus it and use the up and down arrow keys.</p>{/if}
<ol class="items" bind:this={list} class:dragging={!!drag}>
  {#each items as it, i (keyOf(it))}
    <li data-key={keyOf(it)} class:placeholder={drag?.key === keyOf(it)} animate:flip={{ duration: 200 }}>
      <button type="button" class="grip" data-handle={keyOf(it)} title="Drag to reorder"
        aria-label="Move item {i + 1}, {name(it)}. Drag, or use the up and down arrow keys."
        onpointerdown={(e) => startDrag(e, it)} onkeydown={(e) => keyMove(e, it)}>⠿</button>
      <div class="field"><label for="{idPrefix}-{i}-t">Item {i + 1}</label><input id="{idPrefix}-{i}-t" class="input" bind:value={it.title} /></div>
      <div class="field"><label for="{idPrefix}-{i}-x">Item {i + 1} detail</label><input id="{idPrefix}-{i}-x" class="input" bind:value={it.text} /></div>
      <button type="button" class="btn sm ghost rm" onclick={() => items.splice(i, 1)}>Remove<span class="sr-only"> item {i + 1}</span></button>
    </li>
  {/each}
</ol>
<p class="sr-only" role="status">{announce}</p>

{#if drag}
  <div class="lifted" aria-hidden="true" style:left="{drag.x - drag.ox}px" style:top="{drag.y - drag.oy}px" style:width="{drag.w}px">
    <span class="g">⠿</span><strong>{drag.label}</strong>
  </div>
{/if}

<style>
  .tip { font-size: 12.5px; color: var(--muted); }
  .items { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  li { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 12px; align-items: end; border-radius: 10px; }
  .field { min-width: 0; }
  .input { width: 100%; min-width: 0; }
  .grip {
    align-self: end; width: 26px; height: 42px; display: grid; place-items: center; border: 0; border-radius: 8px;
    background: transparent; color: var(--muted); font-size: 16px; line-height: 1; cursor: grab;
    touch-action: none; user-select: none; -webkit-user-select: none; transition: color 0.15s, background 0.15s;
  }
  .grip:hover, .grip:focus-visible { color: var(--lime); background: var(--surface-2); }
  .grip:disabled { cursor: default; opacity: 0.5; }
  @media (pointer: coarse) { .grip { width: 36px; font-size: 18px; } }
  .dragging, .dragging * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
  li.placeholder { outline: 1.5px dashed var(--line-2); outline-offset: 2px; background: rgba(214, 255, 63, 0.04); }
  li.placeholder > * { visibility: hidden; }
  .lifted {
    position: fixed; z-index: 60; pointer-events: none; display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; border: 1px solid var(--lime); border-radius: 10px; background: var(--surface-3);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5); font-size: 14px;
  }
  .lifted .g { color: var(--lime); }
  @media (max-width: 640px) {
    li { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
    .grip { grid-row: 1 / span 3; align-self: start; margin-top: 24px; }
    .rm { justify-self: start; }
  }
</style>
