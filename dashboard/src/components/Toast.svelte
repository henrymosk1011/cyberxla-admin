<script lang="ts">
  // The corner messages (lib/toast.svelte.ts). The words carry the meaning;
  // the mark and color only help. Errors are announced right away.
  import { dismiss, toasts } from "../lib/toast.svelte.ts";
</script>

<div class="toasts" aria-live="polite" aria-label="Notifications">
  {#each toasts.list as t (t.id)}
    <div class="toast t-{t.tone}" role={t.tone === "error" ? "alert" : undefined}>
      <span class="mark" aria-hidden="true">{t.tone === "success" ? "✓" : t.tone === "error" ? "!" : ""}</span>
      <div class="body">
        {#if t.title}<strong>{t.title}</strong>{/if}
        <p><span class="sr-only">{t.tone === "error" ? "Error: " : ""}</span>{t.body}</p>
        {#if t.href}<a href={t.href} onclick={() => dismiss(t.id)}>{t.link ?? "Open"} →</a>{/if}
      </div>
      <button class="x" aria-label="Dismiss" onclick={() => dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; right: 20px; bottom: 20px; z-index: 50; display: flex; flex-direction: column; gap: 10px; width: min(380px, calc(100vw - 40px)); }
  /* Pages with a save bar along the bottom: sit above it. */
  :global(:root:has(.savebar)) .toasts { bottom: 96px; }
  .toast { display: flex; gap: 12px; align-items: flex-start; background: var(--surface-3); border: 1px solid var(--line-2); border-left: 3px solid var(--lime); border-radius: 12px; padding: 14px 14px 14px 16px; box-shadow: 0 16px 40px rgba(0,0,0,0.5); animation: in 0.3s ease; }
  .t-success { border-left-color: var(--good-text); }
  .t-error { border-left-color: var(--critical); }
  .mark { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 800; line-height: 1; background: var(--lime); color: var(--on-lime); }
  .t-info .mark { width: 8px; height: 8px; margin-top: 6px; }
  .t-success .mark { background: var(--good-text); }
  .t-error .mark { background: var(--critical); }
  .body { flex: 1; min-width: 0; }
  strong { font-size: 14px; }
  p { font-size: 14px; color: var(--text); overflow-wrap: anywhere; }
  strong + p { font-size: 13px; color: var(--text-2); margin-top: 2px; }
  a { display: inline-block; margin-top: 6px; font-size: 13px; font-weight: 600; color: var(--lime); text-decoration: none; }
  .x { flex: none; border: 0; background: none; color: var(--text-2); font-size: 20px; line-height: 1; width: 28px; height: 28px; margin: -4px -6px 0 0; border-radius: 8px; }
  .x:hover { color: var(--text); background: var(--surface-2); }
  @keyframes in { from { transform: translateY(12px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
