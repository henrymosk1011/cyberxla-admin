<script lang="ts">
  import type { ToastMsg } from "../lib/types.ts";
  let { toasts, dismiss }: { toasts: ToastMsg[]; dismiss: (id: number) => void } = $props();
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    <div class="toast">
      <span class="dot" aria-hidden="true"></span>
      <div>
        <strong>{t.title}</strong>
        <p>{t.body}</p>
        {#if t.href}<a href={t.href} onclick={() => dismiss(t.id)}>Open lead →</a>{/if}
      </div>
      <button class="x" aria-label="Dismiss" onclick={() => dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; right: 20px; bottom: 20px; z-index: 50; display: flex; flex-direction: column; gap: 10px; width: min(360px, calc(100vw - 40px)); }
  .toast { display: flex; gap: 12px; align-items: flex-start; background: var(--surface-3); border: 1px solid var(--line-2); border-left: 3px solid var(--lime); border-radius: 12px; padding: 14px 14px 14px 16px; box-shadow: 0 16px 40px rgba(0,0,0,0.5); animation: in 0.3s ease; }
  .dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--lime); flex: none; }
  div > div { flex: 1; min-width: 0; }
  strong { font-size: 14px; }
  p { font-size: 13px; color: var(--text-2); margin-top: 2px; overflow-wrap: anywhere; }
  a { display: inline-block; margin-top: 6px; font-size: 13px; font-weight: 600; color: var(--lime); text-decoration: none; }
  .x { border: 0; background: none; color: var(--muted); font-size: 20px; line-height: 1; }
  .x:hover { color: var(--text); }
  @keyframes in { from { transform: translateY(12px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
