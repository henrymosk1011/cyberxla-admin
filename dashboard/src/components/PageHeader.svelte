<script lang="ts">
  // The top of a page: where you are, the title, and the page's tools on the
  // right. The tools keep to one row on a desktop and drop under the title on
  // narrow screens.
  import Icon from "./Icon.svelte";
  import type { Snippet } from "svelte";
  import { pageHeading } from "../lib/nav.svelte.ts";

  let { title, eyebrow = "", sub = "", back, meta, children }: {
    title: string;
    /** Small label above the title. */
    eyebrow?: string;
    /** A line under the title. */
    sub?: string;
    /** The way back to the list this page belongs to. */
    back?: { href: string; label: string };
    /** Under the title: contact details, status. */
    meta?: Snippet;
    /** The tools on the right: search, switches, the main button. */
    children?: Snippet;
  } = $props();
</script>

{#if back}<a class="back" href={back.href}><Icon name="arrow-left" size={14} /> {back.label}</a>{/if}
<header class="head">
  <div class="titles">
    {#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
    <h1 use:pageHeading>{title}</h1>
    {#if sub}<p class="sub">{sub}</p>{/if}
    {#if meta}{@render meta()}{/if}
  </div>
  {#if children}<div class="tools">{@render children()}</div>{/if}
</header>

<style>
  .back { display: inline-block; font-size: var(--fs-sm); color: var(--muted); text-decoration: none; margin-bottom: 16px; }
  .back:hover { color: var(--text); }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px 24px; margin-bottom: 20px; }
  .titles { min-width: 0; }
  h1 { font-size: var(--fs-2xl); letter-spacing: -0.035em; line-height: 1.1; overflow-wrap: anywhere; }
  .eyebrow + h1 { margin-top: 4px; }
  .sub { font-size: var(--fs-md); color: var(--muted); margin-top: 6px; max-width: 760px; }
  .tools { display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex: none; max-width: 100%; }
  /* A search box in the tools has a set width, so it never pushes the buttons to a second row. */
  .tools :global(.search) { width: 280px; height: var(--control-md); flex: 0 1 280px; min-width: 0; }
  @media (max-width: 1100px) {
    .tools :global(.search) { width: 220px; flex-basis: 220px; }
  }
  @media (max-width: 860px) {
    .head { flex-direction: column; align-items: stretch; }
    .tools { justify-content: flex-start; flex-wrap: wrap; }
    .tools :global(.search) { flex: 1 1 200px; width: auto; }
  }
  /* A record's headline number stays beside its name until the screen is phone sized. */
  @media (min-width: 641px) and (max-width: 860px) {
    .head:has(:global(.headvalue)) { flex-direction: row; align-items: flex-end; }
    .head:has(:global(.headvalue)) .tools { justify-content: flex-end; flex-wrap: nowrap; }
  }
  @media (max-width: 640px) {
    h1 { font-size: var(--fs-xl); }
    .tools :global(.search) { flex: 1 1 100%; }
  }
</style>
