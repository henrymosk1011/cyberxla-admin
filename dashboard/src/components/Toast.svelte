<script lang="ts">
  // The corner messages (lib/toast.svelte.ts). The words carry the meaning;
  // the mark and color only help. Errors are announced right away.
  import Icon from "./Icon.svelte";
  import { dismiss, toasts } from "../lib/toast.svelte.ts";
</script>

<div class="toasts" role="region" aria-live="polite" aria-label="Notifications">
  {#each toasts.list as t (t.id)}
    <div class="toast t-{t.tone}" role={t.tone === "error" ? "alert" : undefined}>
      <span class="mark" aria-hidden="true">{#if t.tone === "success"}<Icon name="check" size={12} />{:else if t.tone === "error"}!{/if}</span>
      <div class="body">
        {#if t.title}<strong>{t.title}</strong>{/if}
        <p><span class="sr-only">{t.tone === "error" ? "Error: " : ""}</span>{t.body}</p>
        {#if t.href}<a href={t.href} onclick={() => dismiss(t.id)}>{t.link ?? "Open"} <Icon name="arrow-right" size={14} /></a>{/if}
      </div>
      <button class="iconbtn close" aria-label="Dismiss" onclick={() => dismiss(t.id)}><Icon name="close" /></button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; right: 20px; bottom: 20px; z-index: 50; display: flex; flex-direction: column; gap: 10px; width: min(380px, calc(100vw - 40px)); }
  /* Pages with a save bar along the bottom: sit above it. */
  :global(:root:has(.savebar)) .toasts { bottom: 96px; }
  .toast { display: flex; gap: 12px; align-items: flex-start; background: var(--surface-3); border: 1px solid var(--line-2); border-radius: var(--radius-md); padding: 14px; box-shadow: var(--shadow-md); animation: in 0.3s ease; }
  .mark { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font-size: var(--fs-xs); font-weight: 800; line-height: 1; background: var(--lime); color: var(--on-lime); }
  .t-info .mark { width: 8px; height: 8px; margin-top: 6px; }
  .t-success .mark { background: var(--good-text); }
  .t-error .mark { background: var(--critical); }
  .body { flex: 1; min-width: 0; }
  strong { font-size: var(--fs-md); }
  p { font-size: var(--fs-md); color: var(--text); overflow-wrap: anywhere; }
  strong + p { font-size: var(--fs-sm); color: var(--text-2); margin-top: 2px; }
  a { display: inline-block; margin-top: 6px; font-size: var(--fs-sm); font-weight: 600; color: var(--lime); text-decoration: none; }
  .close { color: var(--text-2); font-size: var(--fs-lg); margin: -4px -6px 0 0; }
  @keyframes in { from { transform: translateY(12px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
