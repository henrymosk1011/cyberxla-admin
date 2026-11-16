<script lang="ts" module>
  export type MenuItem = {
    label: string;
    onselect: () => void;
    /** Shown in red: deleting and the like. It still confirms first. */
    danger?: boolean;
    /** Can't be used right now; say why in hint. */
    disabled?: boolean;
    /** A second line under the label. */
    hint?: string;
  };
</script>

<script lang="ts">
  // A "More" button that opens a short list of actions: the ones a row or a
  // page header doesn't need to show all the time. Enter, Space or the down
  // arrow opens it; the arrow keys, Home and End move; Escape closes it and
  // focus goes back to the button. A click outside, scrolling, or Tab closes it.
  import { tick } from "svelte";

  let { items, label = "More actions" }: { items: MenuItem[]; /** Names what the actions are for, e.g. "More actions for Patching". */ label?: string } = $props();

  const uid = $props.id();
  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let pos = $state({ top: 0, left: 0 });

  const entries = () => [...(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  async function show(last = false) {
    open = true;
    await tick();
    place();
    const els = entries();
    (last ? els.at(-1) : els[0])?.focus();
  }
  /** Under the button, right edges lined up; above it when there is no room below. */
  function place() {
    if (!btn || !list) return;
    const b = btn.getBoundingClientRect(), w = list.offsetWidth, h = list.offsetHeight;
    const below = b.bottom + 6 + h <= innerHeight || b.top - 6 - h < 0;
    pos = { top: below ? b.bottom + 6 : b.top - 6 - h, left: Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) };
  }
  function hide(refocus = true) {
    if (!open) return;
    open = false;
    if (refocus) btn?.focus();
  }
  function pick(it: MenuItem) {
    if (it.disabled) return;
    hide();
    it.onselect();
  }
  function onkey(e: KeyboardEvent) {
    const els = entries(), i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); els.at(-1)?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === "Tab") hide(false);
  }

  // While open: a press anywhere else, a scroll, or a resize closes it.
  $effect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!list?.contains(e.target as Node) && !btn?.contains(e.target as Node)) hide(false);
    };
    const gone = () => hide(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", gone, true);
    window.addEventListener("resize", gone);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", gone, true);
      window.removeEventListener("resize", gone);
    };
  });

  /** The list lives at the end of the page, so nothing it sits in can clip it. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<button
  bind:this={btn} type="button" class="btn sm ghost more" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${uid}-menu` : undefined} aria-label={label} title={label}
  onclick={() => (open ? hide() : show())}
  onkeydown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); show(); } else if (e.key === "ArrowUp") { e.preventDefault(); show(true); } }}
>
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /><circle cx="19" cy="12" r="1.8" fill="currentColor" /></svg>
</button>

{#if open}
  <div use:portal bind:this={list} id="{uid}-menu" class="list" role="menu" aria-label={label} tabindex="-1" style:top="{pos.top}px" style:left="{pos.left}px" onkeydown={onkey}>
    {#each items as it (it.label)}
      <button type="button" role="menuitem" class:danger={it.danger} aria-disabled={it.disabled ? "true" : undefined} onclick={() => pick(it)}>
        <span>{it.label}</span>
        {#if it.hint}<small>{it.hint}</small>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .more { width: 32px; padding: 0; flex: none; color: var(--text-2); }
  .more[aria-expanded="true"] { background: var(--surface-2); color: var(--text); }
  .list {
    position: fixed; z-index: 70; min-width: 180px; max-width: min(300px, calc(100vw - 16px)); padding: 6px;
    border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface-2); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    display: flex; flex-direction: column; gap: 2px; animation: pop 0.12s var(--ease) both;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
  [role="menuitem"] { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-size: 14px; font-weight: 500; color: var(--text); }
  [role="menuitem"]:hover, [role="menuitem"]:focus-visible { background: var(--surface-3); }
  [role="menuitem"]:focus-visible { outline-offset: -2px; }
  [role="menuitem"] small { font-size: 12px; font-weight: 400; color: var(--text-2); }
  .danger span { color: var(--critical); }
  [aria-disabled="true"] { cursor: not-allowed; }
  [aria-disabled="true"] span { color: var(--muted); }
  [aria-disabled="true"]:hover { background: none; }
</style>
