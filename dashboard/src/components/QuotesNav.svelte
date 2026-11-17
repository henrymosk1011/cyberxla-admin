<script lang="ts">
  // The Quotes pages, as one row of tabs under the page title.
  let { current }: { current: "quotes" | "templates" | "settings" | "payments" } = $props();
  const tabs = [
    { id: "quotes", href: "#/quotes", label: "Quotes" },
    { id: "templates", href: "#/quotes/templates", label: "Templates" },
    { id: "settings", href: "#/quotes/settings", label: "Settings" },
    { id: "payments", href: "#/quotes/payments", label: "Payments" },
  ] as const;
</script>

<nav class="subnav" aria-label="Quotes pages">
  {#each tabs as t (t.id)}<a href={t.href} aria-current={current === t.id ? "page" : undefined}>{t.label}</a>{/each}
</nav>

<style>
  .subnav { display: flex; gap: 4px; margin: -4px 0 20px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  a { flex: none; padding: 10px 14px; margin-bottom: -1px; border-bottom: 2px solid transparent; border-radius: 8px 8px 0 0; font-size: var(--fs-md); font-weight: 600; color: var(--text-2); text-decoration: none; transition: color 0.15s, background 0.15s; }
  a:hover { color: var(--text); background: var(--surface); }
  a[aria-current="page"] { color: var(--text); border-bottom-color: var(--lime); }
</style>
